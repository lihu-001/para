"""Business operations shared by HTTP routes and controlled Agent tools."""

from datetime import date
from typing import Literal
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field

# 报销状态：数据库存英文代码，界面统一展示中文名称。
EXPENSE_STATUS_LABELS = {
    "NOT_REQUIRED": "无需报销",
    "SUBMITTED": "已提交",
    "PAID": "已到账",
}
ExpenseStatus = Literal["NOT_REQUIRED", "SUBMITTED", "PAID"]


class ExpenseInput(BaseModel):
    expense_date: date
    amount_minor: int = Field(gt=0)
    merchant: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=100)
    status: str = "SUBMITTED"


class ExpenseUpdate(BaseModel):
    """用户在台账中手动调整三种报销状态。"""

    model_config = ConfigDict(extra="forbid")

    expense_date: date
    amount_minor: int = Field(gt=0)
    merchant: str = Field(min_length=1, max_length=200)
    category: str = Field(min_length=1, max_length=100)
    status: ExpenseStatus


class AllocationInput(BaseModel):
    expense_id: str
    invoice_ids: list[str] = Field(min_length=1)


def create_expense(db, item: ExpenseInput):
    if item.status not in EXPENSE_STATUS_LABELS:
        raise HTTPException(422, "报销状态无效")
    record = {"id": str(uuid4()), **item.model_dump(mode="json")}
    db.execute("INSERT INTO expenses (id, expense_date, amount_minor, merchant, category, status) VALUES (:id, :expense_date, :amount_minor, :merchant, :category, :status)", record)
    return record


def update_expense(db, expense_id: str, item: ExpenseUpdate):
    if db.execute("SELECT 1 FROM expenses WHERE id = ?", (expense_id,)).fetchone() is None:
        raise HTTPException(404, "支出不存在")
    # 发票按完整金额关联且不可拆分，改小金额时不能低于已关联发票总额，否则会出现"超额关联"
    allocated = db.execute("SELECT coalesce(sum(amount_minor), 0) FROM allocations WHERE expense_id = ?", (expense_id,)).fetchone()[0]
    if item.amount_minor < allocated:
        raise HTTPException(422, f"修改后的金额不能低于已关联发票总额 {allocated / 100:.2f} 元")
    record = {"id": expense_id, **item.model_dump(mode="json")}
    db.execute("UPDATE expenses SET expense_date = :expense_date, amount_minor = :amount_minor, merchant = :merchant, category = :category, status = :status WHERE id = :id", record)
    return record


def delete_expense(db, expense_id: str):
    if db.execute("SELECT 1 FROM expenses WHERE id = ?", (expense_id,)).fetchone() is None:
        raise HTTPException(404, "支出不存在")
    # 发票本身保留，只解除与该支出的关联，解除后可重新关联到其他支出
    released = db.execute("DELETE FROM allocations WHERE expense_id = ?", (expense_id,)).rowcount
    db.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    return {"ok": True, "id": expense_id, "released_invoices": released}


def allocation_plan(db, item: AllocationInput):
    if len(set(item.invoice_ids)) != len(item.invoice_ids):
        raise HTTPException(422, "请勿重复选择同一张发票")
    expense = db.execute("SELECT id, merchant, expense_date, amount_minor FROM expenses WHERE id = ?", (item.expense_id,)).fetchone()
    if expense is None:
        raise HTTPException(404, "支出不存在")
    used_expense = db.execute("SELECT coalesce(sum(amount_minor), 0) FROM allocations WHERE expense_id = ?", (item.expense_id,)).fetchone()[0]
    invoices = []
    for invoice_id in item.invoice_ids:
        invoice = db.execute("SELECT id, seller, issue_date, amount_minor FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if invoice is None:
            raise HTTPException(404, "发票不存在")
        if db.execute("SELECT 1 FROM allocations WHERE invoice_id = ?", (invoice_id,)).fetchone():
            raise HTTPException(409, "发票已关联支出，不能重复关联或拆分")
        invoices.append(dict(invoice))
    if used_expense + sum(row["amount_minor"] for row in invoices) > expense["amount_minor"]:
        raise HTTPException(422, "所选发票总金额超过支出剩余金额")
    return {"expense": dict(expense), "invoices": invoices, "amount_minor": sum(row["amount_minor"] for row in invoices)}


def create_allocation(db, item: AllocationInput):
    plan = allocation_plan(db, item)
    records = [{"id": str(uuid4()), "expense_id": item.expense_id, "invoice_id": invoice["id"], "amount_minor": invoice["amount_minor"]} for invoice in plan["invoices"]]
    db.executemany("INSERT INTO allocations (id, expense_id, invoice_id, amount_minor) VALUES (:id, :expense_id, :invoice_id, :amount_minor)", records)
    return records


def get_summary(db):
    expense_total = db.execute("SELECT coalesce(sum(amount_minor), 0) FROM expenses").fetchone()[0]
    invoice_total = db.execute("SELECT coalesce(sum(amount_minor), 0) FROM invoices").fetchone()[0]
    allocated = db.execute("SELECT coalesce(sum(amount_minor), 0) FROM allocations").fetchone()[0]
    pending = db.execute("SELECT coalesce(sum(amount_minor), 0) FROM expenses WHERE status = 'SUBMITTED'").fetchone()[0]
    # 已到账的支出不再计入待补发票金额；仍按每笔支出扣除已关联发票，避免总额相减掩盖逐笔覆盖关系
    uncovered = db.execute("SELECT coalesce(sum(max(CASE WHEN e.status = 'PAID' THEN 0 ELSE e.amount_minor END - coalesce(a.used, 0), 0)), 0) FROM expenses e LEFT JOIN (SELECT expense_id, sum(amount_minor) AS used FROM allocations GROUP BY expense_id) a ON a.expense_id = e.id").fetchone()[0]
    return {"expense_total": expense_total, "invoice_total": invoice_total, "allocated_total": allocated, "uncovered_total": uncovered, "pending_total": pending}


def query_expenses(db, filters):
    allowed = {"date_from", "date_to", "category", "merchant", "status", "has_invoice", "limit"}
    if set(filters) - allowed:
        raise HTTPException(422, "不支持的支出查询条件")
    start, end = filters.get("date_from"), filters.get("date_to")
    try:
        if start is not None:
            start = date.fromisoformat(start).isoformat()
        if end is not None:
            end = date.fromisoformat(end).isoformat()
    except (TypeError, ValueError) as error:
        raise HTTPException(422, "日期必须为 YYYY-MM-DD") from error
    if start and end and start > end:
        raise HTTPException(422, "开始日期不得晚于结束日期")
    limit = filters.get("limit", 20)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise HTTPException(422, "每页仅允许查询 1 至 50 条")
    where, params = [], []
    for sql, value in (("e.expense_date >= ?", start), ("e.expense_date <= ?", end)):
        if value is not None:
            where.append(sql); params.append(value)
    for key in ("category", "merchant", "status"):
        value = filters.get(key)
        if value is not None:
            if not isinstance(value, str) or not value.strip() or len(value) > 200:
                raise HTTPException(422, f"无效的筛选条件：{key}")
            where.append(f"e.{key} = ?" if key != "merchant" else "e.merchant LIKE ? ESCAPE '\\'")
            escaped = value.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            params.append(f"%{escaped}%" if key == "merchant" else value.strip())
    has_invoice = filters.get("has_invoice")
    if has_invoice is not None:
        if type(has_invoice) is not bool:
            raise HTTPException(422, "has_invoice 必须是布尔值")
        where.append("coalesce(a.used, 0) >= e.amount_minor" if has_invoice else "coalesce(a.used, 0) < e.amount_minor")
    clause = " WHERE " + " AND ".join(where) if where else ""
    source = " FROM expenses e LEFT JOIN (SELECT expense_id, sum(amount_minor) AS used FROM allocations GROUP BY expense_id) a ON a.expense_id = e.id"
    total = db.execute("SELECT count(*), coalesce(sum(e.amount_minor), 0), coalesce(sum(max(e.amount_minor - coalesce(a.used, 0), 0)), 0)" + source + clause, params).fetchone()
    rows = [dict(row) for row in db.execute("SELECT e.id, e.expense_date, e.amount_minor, e.merchant, e.category, e.status, coalesce(a.used, 0) AS allocated_minor" + source + clause + " ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC LIMIT ?", (*params, limit))]
    return {"items": rows, "total": total[0], "amount_minor": total[1], "uncovered_minor": total[2], "filters_applied": {**filters, "date_from": start, "date_to": end}, "display_limit": limit, "currency": "CNY"}


def query_invoices(db, filters):
    allowed = {"date_from", "date_to", "seller", "available_only", "limit"}
    if set(filters) - allowed:
        raise HTTPException(422, "不支持的发票查询条件")
    start, end = filters.get("date_from"), filters.get("date_to")
    try:
        if start is not None:
            start = date.fromisoformat(start).isoformat()
        if end is not None:
            end = date.fromisoformat(end).isoformat()
    except (ValueError, TypeError) as error:
        raise HTTPException(422, "日期必须为 YYYY-MM-DD") from error
    if start and end and start > end:
        raise HTTPException(422, "开始日期不得晚于结束日期")
    limit = filters.get("limit", 20)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise HTTPException(422, "每页仅允许查询 1 至 50 条")
    available = filters.get("available_only")
    if available is not None and type(available) is not bool:
        raise HTTPException(422, "available_only 必须是布尔值")
    where, params = [], []
    for sql, value in (("i.issue_date >= ?", start), ("i.issue_date <= ?", end)):
        if value is not None:
            where.append(sql); params.append(value)
    seller = filters.get("seller")
    if seller is not None:
        if not isinstance(seller, str) or not seller.strip() or len(seller) > 200:
            raise HTTPException(422, "销售方筛选无效")
        escaped = seller.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        where.append("i.seller LIKE ? ESCAPE '\\'"); params.append(f"%{escaped}%")
    if available:
        where.append("NOT EXISTS (SELECT 1 FROM allocations a WHERE a.invoice_id = i.id)")
    clause = " WHERE " + " AND ".join(where) if where else ""
    source = " FROM invoices i"
    total = db.execute("SELECT count(*), coalesce(sum(i.amount_minor), 0)" + source + clause, params).fetchone()
    rows = [dict(row) for row in db.execute("SELECT i.id, i.issue_date, i.amount_minor, i.seller, i.invoice_number, EXISTS (SELECT 1 FROM allocations a WHERE a.invoice_id = i.id) AS allocated" + source + clause + " ORDER BY i.issue_date DESC, i.created_at DESC, i.id DESC LIMIT ?", (*params, limit))]
    return {"items": rows, "total": total[0], "amount_minor": total[1], "filters_applied": {**filters, "date_from": start, "date_to": end}, "display_limit": limit, "currency": "CNY"}
