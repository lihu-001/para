"""支出台账手动调整接口测试：修改（含报销状态）、删除，以及按中文状态名搜索。"""

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main
from backend.services import EXPENSE_STATUS_LABELS

EDITABLE_FIELDS = ("expense_date", "amount_minor", "merchant", "category", "status")


class ExpenseApiTest(unittest.TestCase):
    """临时数据库 + TestClient 的公共夹具，本身不含测试用例。"""

    def setUp(self):
        original_connect = main.connect

        @contextmanager
        def closed_connection():
            # 与真实路由一致：with 块结束时提交/回滚，再关闭连接，避免 Windows 下临时目录无法删除
            connection = original_connect()
            try:
                with connection:
                    yield connection
            finally:
                connection.close()

        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.object(main, "DB", Path(directory) / "test.sqlite3"))
        self.enterContext(patch.object(main, "connect", closed_connection))
        self.client = self.enterContext(TestClient(main.app))

    def create_expense(self, **overrides):
        payload = {"expense_date": "2026-09-01", "amount_minor": 1000, "merchant": "原商户", "category": "餐饮", **overrides}
        response = self.client.post("/api/expenses", json=payload)
        self.assertEqual(response.status_code, 201)
        return response.json()

    def put(self, expense, **changes):
        """以现有记录为底稿提交修改，只覆盖传入的字段。"""
        body = {**{key: expense[key] for key in EDITABLE_FIELDS}, **changes}
        return self.client.put(f"/api/expenses/{expense['id']}", json=body)

    def add_invoice(self, invoice_id, amount_minor):
        with main.connect() as db:
            db.execute("INSERT INTO invoices (id, issue_date, amount_minor, seller) VALUES (?, '2026-09-01', ?, '销售方')", (invoice_id, amount_minor))

    def allocate(self, expense, *invoice_ids):
        response = self.client.post("/api/allocations", json={"expense_id": expense["id"], "invoice_ids": list(invoice_ids)})
        self.assertEqual(response.status_code, 201)

    def stored(self):
        return self.client.get("/api/expenses").json()["items"]

    def summary(self):
        return self.client.get("/api/summary").json()


class ExpenseUpdateTest(ExpenseApiTest):
    def test_updates_all_fields_including_status(self):
        expense = self.create_expense(status="NOT_REQUIRED")
        changes = {"expense_date": "2026-09-15", "amount_minor": 2350, "merchant": "新商户", "category": "交通出行", "status": "SUBMITTED"}

        response = self.client.put(f"/api/expenses/{expense['id']}", json=changes)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"id": expense["id"], **changes})
        self.assertEqual(self.stored(), [{"id": expense["id"], **changes}])

    def test_status_can_be_set_freely(self):
        expense = self.create_expense()
        # 手动调整不受状态流转顺序限制：“已提交”可以直接改为“已到账”
        self.assertEqual(self.put(expense, status="PAID").json()["status"], "PAID")
        for status in EXPENSE_STATUS_LABELS:
            with self.subTest(status=status):
                self.assertEqual(self.put(expense, status=status).status_code, 200)
                self.assertEqual(self.stored()[0]["status"], status)

    def test_pending_total_follows_status(self):
        expense = self.create_expense(amount_minor=1000)
        self.assertEqual(self.summary()["pending_total"], 1000)
        self.put(expense, status="PAID")
        self.assertEqual(self.summary()["pending_total"], 0)
        self.put(expense, status="SUBMITTED")
        self.assertEqual(self.summary()["pending_total"], 1000)
        self.put(expense, status="NOT_REQUIRED")
        self.assertEqual(self.summary()["pending_total"], 0)

    def test_uncovered_total_excludes_paid_expenses(self):
        paid = self.create_expense(amount_minor=5000)
        open_expense = self.create_expense(amount_minor=3000)
        self.put(paid, status="PAID")
        self.put(open_expense, status="SUBMITTED")
        self.add_invoice("inv-open", 1000)
        self.allocate(open_expense, "inv-open")

        self.assertEqual(self.summary()["uncovered_total"], 2000)
        self.put(paid, status="SUBMITTED")
        self.assertEqual(self.summary()["uncovered_total"], 7000)


    def test_rejects_missing_expense_and_invalid_fields(self):
        expense = self.create_expense()
        valid = {"expense_date": "2026-09-15", "amount_minor": 100, "merchant": "商户", "category": "餐饮", "status": "PAID"}

        self.assertEqual(self.client.put("/api/expenses/not-exists", json=valid).status_code, 404)
        # 状态只接受已定义的代码（不接受中文名、未知值或空值），也不允许夹带其他字段
        invalid_cases = ({"amount_minor": 0}, {"merchant": ""}, {"expense_date": "2026-13-01"}, {"status": "UNKNOWN"}, {"status": "DRAFT"}, {"status": "IN_REVIEW"}, {"status": "已到账"}, {"status": None}, {"note": "备注"})
        for invalid in invalid_cases:
            with self.subTest(invalid=invalid):
                self.assertEqual(self.client.put(f"/api/expenses/{expense['id']}", json={**valid, **invalid}).status_code, 422)
        without_status = {key: value for key, value in valid.items() if key != "status"}
        self.assertEqual(self.client.put(f"/api/expenses/{expense['id']}", json=without_status).status_code, 422)
        self.assertEqual({key: self.stored()[0][key] for key in ("amount_minor", "status")}, {"amount_minor": 1000, "status": "SUBMITTED"})

    def test_amount_cannot_drop_below_allocated_invoices(self):
        expense = self.create_expense(amount_minor=1000)
        self.add_invoice("inv-1", 800)
        self.allocate(expense, "inv-1")

        too_low = self.put(expense, amount_minor=799, status="PAID")
        self.assertEqual(too_low.status_code, 422)
        self.assertIn("8.00", too_low.json()["detail"])
        # 整体拒绝：金额和状态都不会被部分写入
        self.assertEqual({key: self.stored()[0][key] for key in ("amount_minor", "status")}, {"amount_minor": 1000, "status": "SUBMITTED"})

        self.assertEqual(self.put(expense, amount_minor=800).status_code, 200)
        self.assertEqual(self.summary()["uncovered_total"], 0)


class ExpenseDeleteTest(ExpenseApiTest):
    def test_deletes_expense(self):
        keep = self.create_expense(merchant="保留")
        gone = self.create_expense(merchant="删除", amount_minor=500)

        response = self.client.delete(f"/api/expenses/{gone['id']}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "id": gone["id"], "released_invoices": 0})
        self.assertEqual([row["id"] for row in self.stored()], [keep["id"]])
        self.assertEqual(self.summary()["expense_total"], 1000)
        self.assertEqual(self.client.delete(f"/api/expenses/{gone['id']}").status_code, 404)

    def test_releases_linked_invoices_but_keeps_them(self):
        expense = self.create_expense(amount_minor=1000)
        other = self.create_expense(merchant="另一笔")
        self.add_invoice("inv-1", 300)
        self.add_invoice("inv-2", 400)
        self.allocate(expense, "inv-1", "inv-2")
        self.assertEqual(self.client.get("/api/invoices/available").json()["total"], 0)

        response = self.client.delete(f"/api/expenses/{expense['id']}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["released_invoices"], 2)
        self.assertEqual(self.client.get("/api/allocations").json(), [])
        self.assertEqual(len(self.client.get("/api/invoices").json()), 2)
        self.assertEqual(self.client.get("/api/invoices/available").json()["total"], 2)
        summary = self.summary()
        self.assertEqual((summary["expense_total"], summary["invoice_total"], summary["allocated_total"]), (1000, 700, 0))
        # 解除关联后的发票可以重新关联到其他支出
        self.allocate(other, "inv-1")


class ExpenseStatusSearchTest(ExpenseApiTest):
    def test_search_matches_chinese_status_label(self):
        not_required = self.create_expense(merchant="甲商户", status="NOT_REQUIRED")
        paid = self.create_expense(merchant="乙商户")
        submitted = self.create_expense(merchant="丙商户")
        self.assertEqual(self.put(paid, status="PAID").status_code, 200)

        def found(search):
            return {row["id"] for row in self.client.get("/api/expenses", params={"search": search}).json()["items"]}

        self.assertEqual(found("已到账"), {paid["id"]})
        self.assertEqual(found("提交"), {submitted["id"]})
        self.assertEqual(found("无需报销"), {not_required["id"]})
        self.assertEqual(found("PAID"), set())
        self.assertEqual(found(""), {not_required["id"], paid["id"], submitted["id"]})


if __name__ == "__main__":
    unittest.main()
