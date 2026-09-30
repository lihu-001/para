"""Local-first PARA API. Start with: uvicorn backend.main:app --reload"""

from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
import base64
import json
import mimetypes
from uuid import uuid4
from urllib.parse import urlsplit

import pymupdf as fitz
import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .ai_agent import AgentError, run_agent
from .ai_invoice import AIConfigurationError, parse_invoice_images
from .database import connect as _connect, initialize as _initialize
from .services import EXPENSE_STATUS_LABELS, AllocationInput, ExpenseInput, ExpenseUpdate, allocation_plan, create_allocation, create_expense, delete_expense, get_summary, query_expenses, query_invoices, update_expense
from pydantic import ValidationError

DB = Path(__file__).resolve().parent.parent / "data" / "para.sqlite3"
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "data" / "invoices"
AGENT_UPLOAD_DIR = Path(__file__).resolve().parent.parent / "data" / "agent_uploads"
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_AGENT_FILES = 5
MAX_PDF_PAGES = 6

def connect():
    return _connect(DB)

def initialize():
    return _initialize(connect, UPLOAD_DIR, AGENT_UPLOAD_DIR)




@asynccontextmanager
async def lifespan(_app: FastAPI):
    initialize()
    yield


app = FastAPI(title="PARA API", lifespan=lifespan)


class InvoiceInput(BaseModel):
    issue_date: date
    amount_minor: int = Field(gt=0)
    seller: str = Field(min_length=1, max_length=200)
    seller_tax_number: str | None = Field(default=None, max_length=100)
    buyer_name: str | None = Field(default=None, max_length=200)
    buyer_tax_number: str | None = Field(default=None, max_length=100)
    invoice_number: str | None = None
    source_pdf: str
    ai_result_json: str | None = None


class AISettingsInput(BaseModel):
    base_url: str = Field(min_length=1, max_length=500)
    model: str = Field(min_length=1, max_length=200)
    api_key: str | None = None
    retention: str = "keep"
    models: list[str] | None = None


class ConversationInput(BaseModel):
    title: str = Field(default="新对话", min_length=1, max_length=100)


class MessageInput(BaseModel):
    content: str = Field(default="", max_length=4000)

@app.get("/api/health")
def health():
    return {"status": "ok"}


def load_ai_settings():
    with connect() as db:
        config = dict(db.execute("SELECT base_url, model, api_key, retention, models_json FROM ai_settings WHERE id = 1").fetchone())
    config["models"] = json.loads(config.pop("models_json"))
    return config


@app.get("/api/ai/settings")
def ai_settings():
    config = load_ai_settings()
    return {"configured": bool(config["api_key"]), "base_url": config["base_url"], "model": config["model"], "models": config["models"], "retention": config["retention"]}

class AIModelsInput(BaseModel):
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str | None = None


def _provider_url(base_url: str) -> str:
    try:
        parsed = urlsplit(base_url)
        valid_host = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (parsed.scheme != "https" and not (parsed.scheme == "http" and valid_host)) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError
        _ = parsed.port
    except ValueError:
        raise HTTPException(422, "API 地址必须使用 HTTPS，或指向本机") from None
    return base_url.rstrip("/")


def _provider_key(base_url: str, entered_key: str | None, config: dict) -> str:
    api_key = entered_key or (config["api_key"] if base_url == config["base_url"] else "")
    if not api_key:
        raise HTTPException(422, "请先填写 API Key")
    return api_key


@app.post("/api/ai/models")
def discover_ai_models(item: AIModelsInput):
    base_url = _provider_url(item.base_url)
    api_key = _provider_key(base_url, item.api_key, load_ai_settings())
    try:
        response = httpx.get(f"{base_url}/models", headers={"Authorization": f"Bearer {api_key}"}, timeout=30)
        response.raise_for_status()
        data = response.json()["data"]
        if not isinstance(data, list):
            raise ValueError("invalid")
        models = []
        for entry in data:
            identifier = entry["id"]
            if not isinstance(identifier, str) or not identifier.strip():
                raise ValueError("invalid")
            if identifier not in models:
                models.append(identifier)
    except httpx.HTTPStatusError as error:
        raise HTTPException(502, f"获取模型列表失败：服务商返回 HTTP {error.response.status_code}") from error
    except httpx.HTTPError as error:
        raise HTTPException(502, "获取模型列表失败：无法连接服务商") from error
    except (KeyError, TypeError, ValueError) as error:
        raise HTTPException(502, "获取模型列表失败：服务商未返回有效的模型列表") from error
    return {"models": models}


@app.post("/api/ai/test")
def test_ai_settings(item: AISettingsInput):
    base_url = _provider_url(item.base_url)
    if not item.model.strip():
        raise HTTPException(422, "模型名称不能为空")
    config = load_ai_settings()
    api_key = item.api_key or config["api_key"]
    try:
        response = httpx.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": item.model, "messages": [{"role": "user", "content": "Reply with exactly PARA_CONNECTION_OK and nothing else."}], "max_tokens": 10, "temperature": 0},
            timeout=30,
        )
        response.raise_for_status()
        body = response.json()
        returned_model = body.get("model")
        content = body["choices"][0]["message"]["content"]
        if returned_model and returned_model != item.model:
            raise ValueError(f"服务商返回了模型 {returned_model}，不是所填模型 {item.model}")
        if not isinstance(content, str) or content.strip() != "PARA_CONNECTION_OK":
            raise ValueError("服务商未返回有效的连接测试结果")
    except httpx.HTTPStatusError as error:
        raise HTTPException(502, f"AI 接口测试失败：服务商返回 HTTP {error.response.status_code}") from error
    except httpx.HTTPError as error:
        raise HTTPException(502, "AI 接口测试失败：无法连接服务商") from error
    except (KeyError, IndexError, TypeError, ValueError) as error:
        raise HTTPException(502, f"AI 接口测试失败：{error}") from error
    return {"ok": True, "message": "连接测试成功"}

@app.put("/api/ai/settings")
def update_ai_settings(item: AISettingsInput):
    base_url = _provider_url(item.base_url)
    if item.retention not in {"keep", "delete_after_confirmation"}:
        raise HTTPException(422, "原件策略无效")
    config = load_ai_settings()
    models = item.models if item.models is not None else (config["models"] if base_url == config["base_url"] and item.api_key in (None, config["api_key"]) else [])
    if any(not model.strip() or model != model.strip() or len(model) > 200 for model in models) or len(models) != len(set(models)):
        raise HTTPException(422, "模型列表无效")
    if models and item.model not in models:
        raise HTTPException(422, "默认模型不在模型列表中")
    with connect() as db:
        db.execute("UPDATE ai_settings SET base_url = ?, model = ?, models_json = ?, api_key = ?, retention = ? WHERE id = 1", (base_url, item.model, json.dumps(models, ensure_ascii=False), item.api_key if item.api_key is not None else (config["api_key"] if base_url == config["base_url"] else ""), item.retention))
    return ai_settings()


@app.get("/api/expenses")
def expenses(page: int = 1, page_size: int = 10, search: str = ""):
    if page < 1 or page_size < 1 or page_size > 50:
        raise HTTPException(422, "分页参数无效")
    keyword = search.strip()
    escaped = keyword.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    term = f"%{escaped}%"
    # 页面只展示中文状态名，搜索也按中文名匹配，再换成库里存的状态代码
    statuses = [code for code, label in EXPENSE_STATUS_LABELS.items() if keyword and keyword in label]
    status_clause = f" OR e.status IN ({', '.join('?' for _ in statuses)})" if statuses else ""
    where = f"FROM expenses e WHERE (e.merchant LIKE ? ESCAPE '\\' OR e.category LIKE ? ESCAPE '\\'{status_clause})"
    params = (term, term, *statuses)
    with connect() as db:
        total = db.execute(f"SELECT count(*) {where}", params).fetchone()[0]
        items = [dict(row) for row in db.execute(
            f"SELECT e.id, e.expense_date, e.amount_minor, e.merchant, e.category, e.status {where} "
            "ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC LIMIT ? OFFSET ?",
            (*params, page_size, (page - 1) * page_size),
        )]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@app.post("/api/expenses", status_code=201)
def add_expense(item: ExpenseInput):
    with connect() as db:
        return create_expense(db, item)


@app.put("/api/expenses/{expense_id}")
def edit_expense(expense_id: str, item: ExpenseUpdate):
    with connect() as db:
        # 与新增关联同样加写锁，避免"校验已关联金额"和"写入新金额"之间插入新的关联
        db.execute("BEGIN IMMEDIATE")
        return update_expense(db, expense_id, item)


@app.delete("/api/expenses/{expense_id}")
def remove_expense(expense_id: str):
    with connect() as db:
        # 解除发票关联与删除支出在同一事务内完成，任何一步失败都整体回滚
        db.execute("BEGIN IMMEDIATE")
        return delete_expense(db, expense_id)


@app.get("/api/invoices")
def invoices(page: int | None = None, page_size: int = 10, search: str = ""):
    with connect() as db:
        if page is None:
            return [dict(row) for row in db.execute("SELECT id, issue_date, amount_minor, seller, seller_tax_number, buyer_name, buyer_tax_number, invoice_number, source_pdf, created_at FROM invoices ORDER BY issue_date DESC, created_at DESC")]
        if page < 1 or page_size < 1 or page_size > 50:
            raise HTTPException(422, "分页参数无效")
        escaped = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        term = f"%{escaped}%"
        where = "FROM invoices WHERE seller LIKE ? ESCAPE '\\' OR seller_tax_number LIKE ? ESCAPE '\\' OR buyer_name LIKE ? ESCAPE '\\' OR buyer_tax_number LIKE ? ESCAPE '\\' OR invoice_number LIKE ? ESCAPE '\\'"
        params = (term,) * 5
        total = db.execute(f"SELECT count(*) {where}", params).fetchone()[0]
        rows = [dict(row) for row in db.execute(f"SELECT id, issue_date, amount_minor, seller, seller_tax_number, buyer_name, buyer_tax_number, invoice_number, source_pdf, created_at {where} ORDER BY issue_date DESC, created_at DESC, id DESC LIMIT ? OFFSET ?", (*params, page_size, (page - 1) * page_size))]
    return {"items": rows, "total": total, "page": page, "page_size": page_size}

@app.get("/api/invoices/available")
def available_invoices(page: int = 1, page_size: int = 10, search: str = ""):
    if page < 1 or page_size < 1 or page_size > 50:
        raise HTTPException(422, "分页参数无效")
    term = f"%{search.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')}%"
    where = "FROM invoices i WHERE NOT EXISTS (SELECT 1 FROM allocations a WHERE a.invoice_id = i.id) AND i.seller LIKE ? ESCAPE '\\'"
    with connect() as db:
        total = db.execute(f"SELECT count(*) {where}", (term,)).fetchone()[0]
        items = [dict(row) for row in db.execute(f"SELECT i.id, i.issue_date, i.amount_minor, i.seller, i.seller_tax_number, i.buyer_name, i.buyer_tax_number, i.invoice_number {where} ORDER BY i.issue_date DESC, i.created_at DESC, i.id DESC LIMIT ? OFFSET ?", (term, page_size, (page - 1) * page_size))]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@app.post("/api/invoices/parse")
async def parse_invoice(file: UploadFile = File(...)):
    filename = file.filename or "invoice"
    content_type = file.content_type or ""
    is_pdf = content_type == "application/pdf"
    is_image = content_type in {"image/png", "image/jpeg", "image/webp"}
    if not is_pdf and not is_image:
        raise HTTPException(415, "只支持 PDF、PNG、JPEG 或 WebP 发票")
    content = await file.read()
    if not content or len(content) > MAX_FILE_BYTES:
        raise HTTPException(413, "文件为空或超过 20 MB")
    images: list[bytes]
    mime_type = "image/png"
    if is_pdf:
        try:
            with fitz.open(stream=content, filetype="pdf") as document:
                if not document.page_count or document.page_count > MAX_PDF_PAGES:
                    raise ValueError("PDF 必须包含 1 至 6 页")
                images = [page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).tobytes("png") for page in document]
        except (fitz.FileDataError, fitz.EmptyFileError, ValueError) as error:
            raise HTTPException(422, f"无法读取 PDF：{error}") from error
    else:
        images = [content]
        mime_type = content_type
    try:
        ai_result = parse_invoice_images(images, mime_type, load_ai_settings)
    except AIConfigurationError as error:
        raise HTTPException(422, str(error)) from error
    token = str(uuid4())
    stored_name = f"{token}{'.pdf' if is_pdf else Path(filename).suffix.lower() or '.img'}"
    (UPLOAD_DIR / stored_name).write_bytes(content)
    with connect() as db:
        db.execute("INSERT INTO pending_invoice_pdfs (token, stored_name, ai_result_json) VALUES (?, ?, ?)", (token, stored_name, json.dumps(ai_result, ensure_ascii=False)))
    return {"token": token, "filename": filename, "fields": ai_result}


@app.post("/api/invoices/confirm", status_code=201)
def confirm_invoice(item: InvoiceInput):
    with connect() as db:
        pending = db.execute("SELECT stored_name, ai_result_json FROM pending_invoice_pdfs WHERE token = ?", (item.source_pdf,)).fetchone()
        if pending is None:
            raise HTTPException(404, "解析结果已失效，请重新上传")
        retention = load_ai_settings()["retention"]
        if retention not in {"keep", "delete_after_confirmation"}:
            raise HTTPException(422, "原件策略无效")
        record = {"id": str(uuid4()), **item.model_dump(mode="json"), "source_pdf": pending[0] if retention == "keep" else None, "ai_result_json": pending[1]}
        db.execute("INSERT INTO invoices (id, issue_date, amount_minor, seller, seller_tax_number, buyer_name, buyer_tax_number, invoice_number, source_pdf, ai_result_json) VALUES (:id, :issue_date, :amount_minor, :seller, :seller_tax_number, :buyer_name, :buyer_tax_number, :invoice_number, :source_pdf, :ai_result_json)", record)
    if retention == "delete_after_confirmation":
        (UPLOAD_DIR / pending[0]).unlink(missing_ok=True)
    return record


@app.delete("/api/invoices/{invoice_id}")
def remove_invoice(invoice_id: str):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT source_pdf FROM invoices WHERE id = ?", (invoice_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "发票不存在")
        db.execute("DELETE FROM allocations WHERE invoice_id = ?", (invoice_id,))
        db.execute("DELETE FROM invoices WHERE id = ?", (invoice_id,))
    if row[0]:
        (UPLOAD_DIR / row[0]).unlink(missing_ok=True)
    return {"ok": True, "id": invoice_id}


@app.get("/api/allocations")
def allocations():
    with connect() as db:
        return [dict(row) for row in db.execute("SELECT * FROM allocations")]


@app.post("/api/allocations", status_code=201)
def add_allocation(item: AllocationInput):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        return create_allocation(db, item)


@app.get("/api/summary")
def summary():
    with connect() as db:
        return get_summary(db)
@app.post("/api/agent/conversations", status_code=201)
def create_conversation(item: ConversationInput):
    conversation_id = str(uuid4())
    with connect() as db:
        db.execute("INSERT INTO agent_conversations (id, title) VALUES (?, ?)", (conversation_id, item.title.strip()))
    return {"id": conversation_id, "title": item.title.strip(), "messages": [], "pending_actions": []}


@app.get("/api/agent/conversations")
def list_conversations():
    with connect() as db:
        return [dict(row) for row in db.execute("SELECT id, title, created_at, updated_at FROM agent_conversations ORDER BY updated_at DESC, created_at DESC")]


@app.get("/api/agent/conversations/{conversation_id}")
def get_conversation(conversation_id: str):
    with connect() as db:
        conversation = db.execute("SELECT id, title, created_at, updated_at FROM agent_conversations WHERE id = ?", (conversation_id,)).fetchone()
        if conversation is None:
            raise HTTPException(404, "对话不存在")
        messages = [dict(row) for row in db.execute("SELECT id, role, content, tool_name, tool_call_id, tool_arguments_json, tool_result_json, attachments_json, created_at FROM agent_messages WHERE conversation_id = ? ORDER BY rowid", (conversation_id,))]
        pending = [dict(row) for row in db.execute("SELECT id, action_type, preview_json, status, created_at FROM agent_pending_actions WHERE conversation_id = ? AND status = 'PENDING' ORDER BY created_at", (conversation_id,))]
    for item in messages:
        if item.get("tool_arguments_json"):
            item["tool_arguments"] = json.loads(item.pop("tool_arguments_json"))
        else:
            item.pop("tool_arguments_json", None)
        if item.get("tool_result_json"):
            item["tool_result"] = json.loads(item.pop("tool_result_json"))
        else:
            item.pop("tool_result_json", None)
        item["attachments"] = json.loads(item.pop("attachments_json") or "[]")
    for item in pending:
        item["preview"] = json.loads(item.pop("preview_json"))
    return {**dict(conversation), "messages": messages, "pending_actions": pending}

@app.delete("/api/agent/conversations/{conversation_id}")
def delete_conversation(conversation_id: str):
    attachment_names: set[str] = set()
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        if db.execute("SELECT 1 FROM agent_conversations WHERE id = ?", (conversation_id,)).fetchone() is None:
            raise HTTPException(404, "对话不存在")
        rows = db.execute("SELECT attachments_json FROM agent_messages WHERE conversation_id = ?", (conversation_id,)).fetchall()
        for row in rows:
            try:
                attachments = json.loads(row["attachments_json"] or "[]")
            except (TypeError, ValueError):
                attachments = []
            for attachment in attachments:
                stored_name = attachment.get("stored_name") if isinstance(attachment, dict) else None
                path = AGENT_UPLOAD_DIR / stored_name if isinstance(stored_name, str) else None
                if path is not None and path.parent == AGENT_UPLOAD_DIR and path.name == stored_name:
                    attachment_names.add(stored_name)
        db.execute("DELETE FROM agent_conversations WHERE id = ?", (conversation_id,))
    for stored_name in attachment_names:
        (AGENT_UPLOAD_DIR / stored_name).unlink(missing_ok=True)
    return {"ok": True, "id": conversation_id}

@app.get("/api/agent/attachments/{stored_name}")
def get_agent_attachment(stored_name: str):
    with connect() as db:
        row = db.execute("SELECT attachments_json FROM agent_messages WHERE attachments_json IS NOT NULL AND attachments_json LIKE ?", (f"%{stored_name}%",)).fetchone()
    if row is None or not any(item["stored_name"] == stored_name for item in json.loads(row["attachments_json"])):
        raise HTTPException(404, "附件不存在")
    path = AGENT_UPLOAD_DIR / stored_name
    if not path.is_file() or path.parent != AGENT_UPLOAD_DIR or Path(stored_name).name != stored_name:
        raise HTTPException(404, "附件不存在")
    return FileResponse(path, media_type="application/octet-stream", filename=next(item["name"] for item in json.loads(row["attachments_json"]) if item["stored_name"] == stored_name))


async def _read_agent_files(files: list[UploadFile]) -> tuple[list[dict], list[dict]]:
    if len(files) > MAX_AGENT_FILES:
        raise HTTPException(413, f"一次最多上传 {MAX_AGENT_FILES} 个文件")
    metadata: list[dict] = []
    model_parts: list[dict] = []
    pending_files: list[tuple[str, bytes]] = []
    for upload in files:
        filename = Path((upload.filename or "未命名文件").replace("\\", "/")).name
        content_type = upload.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
        content = await upload.read(MAX_FILE_BYTES + 1)
        if not content or len(content) > MAX_FILE_BYTES:
            raise HTTPException(413, "文件为空或超过 20 MB")
        if content_type in {"image/png", "image/jpeg", "image/webp"}:
            encoded = base64.b64encode(content).decode("ascii")
            model_parts.append({"type": "image_url", "image_url": {"url": f"data:{content_type};base64,{encoded}"}})
        elif content_type == "application/pdf" or filename.lower().endswith(".pdf"):
            try:
                with fitz.open(stream=content, filetype="pdf") as document:
                    extracted = "\n".join(page.get_text() for page in document)[:100000]
            except (fitz.FileDataError, fitz.EmptyFileError) as error:
                raise HTTPException(422, f"无法读取 PDF：{error}") from error
            model_parts.append({"type": "text", "text": f"文件 {filename} 内容：\n{extracted or 'PDF 没有可提取的文字'}"})
        elif content_type.startswith("text/") or filename.lower().endswith((".txt", ".md", ".json", ".csv", ".py", ".ts", ".tsx")):
            model_parts.append({"type": "text", "text": f"文件 {filename} 内容：\n{content.decode('utf-8-sig', errors='replace')[:100000]}"})
        else:
            raise HTTPException(415, "只支持 PNG/JPEG/WebP 图片、PDF 和文本文件")
        stored_name = str(uuid4())
        pending_files.append((stored_name, content))
        metadata.append({"name": filename, "content_type": content_type, "size": len(content), "stored_name": stored_name})
    for stored_name, content in pending_files:
        (AGENT_UPLOAD_DIR / stored_name).write_bytes(content)
    return metadata, model_parts


@app.post("/api/agent/conversations/{conversation_id}/messages")
async def send_agent_message(conversation_id: str, content: str = Form(default="", max_length=4000), files: list[UploadFile] = File(default=[]), model: str | None = Form(default=None)):
    with connect() as db:
        if db.execute("SELECT 1 FROM agent_conversations WHERE id = ?", (conversation_id,)).fetchone() is None:
            raise HTTPException(404, "对话不存在")
    text = content.strip()
    if not text and not files:
        raise HTTPException(422, "消息或附件不能为空")
    config = load_ai_settings()
    if model is not None:
        allowed = config["models"] or [config["model"]]
        if model not in allowed:
            raise HTTPException(422, "所选模型不在已保存的模型列表中")
        config["model"] = model
    metadata, model_parts = await _read_agent_files(files)
    user_content: str | list[dict] = text
    if model_parts:
        user_content = ([{"type": "text", "text": text}] if text else []) + model_parts
    with connect() as db:
        if db.execute("SELECT 1 FROM agent_conversations WHERE id = ?", (conversation_id,)).fetchone() is None:
            raise HTTPException(404, "对话不存在")
        history = [dict(row) for row in db.execute("SELECT role, content, tool_call_id, tool_calls_json, attachments_json FROM agent_messages WHERE conversation_id = ? ORDER BY rowid", (conversation_id,))]
        for message in history:
            calls_json = message.pop("tool_calls_json", None)
            attachments = json.loads(message.get("attachments_json") or "[]")
            if message["role"] == "user" and attachments:
                parts = [{"type": "text", "text": message["content"]}]
                for attachment in attachments:
                    if attachment["content_type"].startswith("text/") or attachment["name"].lower().endswith((".txt", ".md", ".csv", ".json")):
                        path = AGENT_UPLOAD_DIR / attachment["stored_name"]
                        if path.is_file():
                            parts.append({"type": "text", "text": f"文件 {attachment['name']} 内容：\n{path.read_bytes().decode('utf-8-sig', errors='replace')[:100000]}"})
                message["content"] = parts
            message.pop("attachments_json", None)
            if calls_json:
                message["tool_calls"] = json.loads(calls_json)
        db.execute("INSERT INTO agent_messages (id, conversation_id, role, content, attachments_json) VALUES (?, ?, 'user', ?, ?)", (str(uuid4()), conversation_id, text, json.dumps(metadata, ensure_ascii=False)))

    def execute_tool(name: str, arguments: dict):
        with connect() as tool_db:
            if name == "query_expenses": return query_expenses(tool_db, arguments)
            if name == "query_invoices": return query_invoices(tool_db, arguments)
            if name == "get_summary":
                if arguments: raise HTTPException(422, "汇总工具不接受参数")
                return {**get_summary(tool_db), "currency": "CNY"}
            if name == "prepare_create_expense":
                if tool_db.execute("SELECT 1 FROM agent_pending_actions WHERE conversation_id = ? AND status = 'PENDING'", (conversation_id,)).fetchone(): raise HTTPException(409, "请先确认或取消已有的待处理操作")
                if set(arguments) != {"expense_date", "amount_minor", "merchant", "category"}: raise HTTPException(422, "新增支出的字段无效")
                expense = ExpenseInput(**arguments); payload = expense.model_dump(mode="json"); preview = {"action": "create_expense", "expense": payload, "requires_confirmation": True}
            elif name == "prepare_import_expenses":
                if tool_db.execute("SELECT 1 FROM agent_pending_actions WHERE conversation_id = ? AND status = 'PENDING'", (conversation_id,)).fetchone(): raise HTTPException(409, "请先确认或取消已有的待处理操作")
                if set(arguments) != {"records"} or not isinstance(arguments["records"], list) or not 1 <= len(arguments["records"]) <= 200:
                    raise HTTPException(422, "批量支出必须包含 1 至 200 条记录")
                if any(not isinstance(row, dict) or set(row) != {"expense_date", "amount_minor", "merchant", "category"} for row in arguments["records"]):
                    raise HTTPException(422, "批量支出字段无效")
                try:
                    payload = []
                    for row in arguments["records"]:
                        if row["expense_date"] is None:
                            validated = ExpenseInput(**{**row, "expense_date": date(2000, 1, 1)})
                            payload.append({**validated.model_dump(mode="json"), "expense_date": None})
                        else:
                            payload.append(ExpenseInput(**row).model_dump(mode="json"))
                except ValidationError as error:
                    raise HTTPException(422, "批量支出包含无效日期、金额或商户") from error
                payload = {"records": payload}
                preview = {"action": "import_expenses", "expenses": payload["records"], "amount_minor": sum(row["amount_minor"] for row in payload["records"]), "requires_confirmation": True}
            elif name == "prepare_allocation":
                if tool_db.execute("SELECT 1 FROM agent_pending_actions WHERE conversation_id = ? AND status = 'PENDING'", (conversation_id,)).fetchone(): raise HTTPException(409, "请先确认或取消已有的待处理操作")
                if set(arguments) != {"expense_id", "invoice_ids"}: raise HTTPException(422, "发票关联字段无效")
                allocation = AllocationInput(**arguments); payload = allocation.model_dump(); preview = {"action": "allocate_invoice", **allocation_plan(tool_db, allocation), "requires_confirmation": True}
            else: raise HTTPException(422, "不支持的 Agent 工具")
            action_id = str(uuid4())
            tool_db.execute("INSERT INTO agent_pending_actions (id, conversation_id, action_type, arguments_json, preview_json) VALUES (?, ?, ?, ?, ?)", (action_id, conversation_id, name, json.dumps(payload, ensure_ascii=False), json.dumps(preview, ensure_ascii=False)))
            return {"pending_action": {"id": action_id, **preview}}

    try:
        result = run_agent(user_content, history, config, execute_tool)
    except AgentError as error: raise HTTPException(502, str(error)) from error
    except HTTPException: raise
    except (ValueError, TypeError, ValidationError) as error: raise HTTPException(422, "Agent 工具参数无效") from error
    with connect() as db:
        for message in result.get("transcript", []):
            db.execute("INSERT INTO agent_messages (id, conversation_id, role, content, tool_call_id, tool_calls_json, tool_name, tool_arguments_json, tool_result_json, attachments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')", (str(uuid4()), conversation_id, message["role"], message["content"], message.get("tool_call_id"), json.dumps(message.get("tool_calls"), ensure_ascii=False) if message.get("tool_calls") else None, message.get("tool_name"), message.get("tool_arguments_json"), message.get("tool_result_json")))
        db.execute("INSERT INTO agent_messages (id, conversation_id, role, content, attachments_json) VALUES (?, ?, 'assistant', ?, '[]')", (str(uuid4()), conversation_id, result["content"]))
        db.execute("UPDATE agent_conversations SET updated_at = datetime('now') WHERE id = ?", (conversation_id,))
    return result


@app.post("/api/agent/actions/{action_id}/confirm")
def confirm_agent_action(action_id: str, dates: dict[str, str] | None = None):
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        action = db.execute("SELECT * FROM agent_pending_actions WHERE id = ?", (action_id,)).fetchone()
        if action is None:
            raise HTTPException(404, "待确认操作不存在")
        if action["status"] != "PENDING":
            raise HTTPException(409, "待确认操作已处理")
        if action["action_type"] == "prepare_create_expense":
            record = create_expense(db, ExpenseInput(**json.loads(action["arguments_json"])))
            description = f"已确认并记录支出：{record['merchant']}。"
        elif action["action_type"] == "prepare_import_expenses":
            arguments = json.loads(action["arguments_json"])
            rows = arguments["records"]
            if any(row["expense_date"] is None and (dates is None or str(index) not in dates) for index, row in enumerate(rows)):
                raise HTTPException(422, "请先填写所有缺失的支出日期")
            if dates and any(not key.isdecimal() or int(key) >= len(rows) or rows[int(key)]["expense_date"] is not None for key in dates):
                raise HTTPException(422, "只能填写预览中缺失的日期")
            try:
                validated = [ExpenseInput(**{**row, "expense_date": (dates or {}).get(str(index), row["expense_date"])}) for index, row in enumerate(rows)]
            except ValidationError as error:
                raise HTTPException(422, "支出日期无效，请使用 YYYY-MM-DD") from error
            record = [create_expense(db, row) for row in validated]
            description = f"已确认并记录 {len(record)} 笔支出。"
        elif action["action_type"] == "prepare_allocation":
            record = create_allocation(db, AllocationInput(**json.loads(action["arguments_json"])))
            description = "已确认并关联发票。"
        else:
            raise HTTPException(422, "不支持的待确认操作")
        db.execute("UPDATE agent_pending_actions SET status = 'EXECUTED', confirmed_at = datetime('now') WHERE id = ?", (action_id,))
        db.execute("INSERT INTO agent_messages (id, conversation_id, role, content) VALUES (?, ?, 'assistant', ?)", (str(uuid4()), action["conversation_id"], description))
    return {"ok": True, "record": record}


@app.post("/api/agent/actions/{action_id}/cancel")
def cancel_agent_action(action_id: str):
    with connect() as db:
        result = db.execute("UPDATE agent_pending_actions SET status = 'CANCELLED' WHERE id = ? AND status = 'PENDING'", (action_id,))
        if not result.rowcount:
            raise HTTPException(409, "待确认操作不存在或已处理")
    return {"ok": True}
