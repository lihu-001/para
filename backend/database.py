"""SQLite connection and schema initialization for the PARA application."""

from pathlib import Path
import sqlite3
from collections.abc import Callable


def connect(db_path: Path):
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize(connection_factory: Callable[[], sqlite3.Connection], upload_dir: Path, agent_upload_dir: Path):
    upload_dir.mkdir(parents=True, exist_ok=True)
    agent_upload_dir.mkdir(parents=True, exist_ok=True)
    with connection_factory() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS expenses (
            id TEXT PRIMARY KEY, expense_date TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
            merchant TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SUBMITTED', created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS invoices (
            id TEXT PRIMARY KEY, issue_date TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK (amount_minor > 0), seller TEXT NOT NULL,
            invoice_number TEXT, buyer_name TEXT, buyer_tax_number TEXT, seller_tax_number TEXT,
            source_pdf TEXT, extracted_text TEXT, ai_result_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS pending_invoice_pdfs (
            token TEXT PRIMARY KEY, stored_name TEXT NOT NULL, ai_result_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS allocations (
            id TEXT PRIMARY KEY, expense_id TEXT NOT NULL REFERENCES expenses(id), invoice_id TEXT NOT NULL REFERENCES invoices(id),
            amount_minor INTEGER NOT NULL CHECK (amount_minor > 0), UNIQUE (expense_id, invoice_id)
        );
        CREATE TABLE IF NOT EXISTS agent_conversations (
            id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_messages (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')), content TEXT NOT NULL,
            tool_call_id TEXT, tool_calls_json TEXT, tool_name TEXT, tool_arguments_json TEXT, tool_result_json TEXT,
            attachments_json TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS agent_pending_actions (
            id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
            action_type TEXT NOT NULL, arguments_json TEXT NOT NULL, preview_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'CONFIRMED', 'EXECUTED', 'CANCELLED', 'FAILED')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')), confirmed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS ai_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            base_url TEXT NOT NULL DEFAULT 'https://api.openai.com/v1', model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
            api_key TEXT NOT NULL DEFAULT '', retention TEXT NOT NULL DEFAULT 'keep' CHECK (retention IN ('keep', 'delete_after_confirmation')),
            models_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS migrations (
            name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO ai_settings (id) VALUES (1);
        """)
        columns = {row[1] for row in db.execute("PRAGMA table_info(invoices)")}
        for name in ("source_pdf", "extracted_text", "ai_result_json", "buyer_name", "buyer_tax_number", "seller_tax_number"):
            if name not in columns:
                db.execute(f"ALTER TABLE invoices ADD COLUMN {name} TEXT")
        message_columns = {row[1] for row in db.execute("PRAGMA table_info(agent_messages)")}
        if "attachments_json" not in message_columns:
            db.execute("ALTER TABLE agent_messages ADD COLUMN attachments_json TEXT")
        settings_columns = {row[1] for row in db.execute("PRAGMA table_info(ai_settings)")}
        if "models_json" not in settings_columns:
            db.execute("ALTER TABLE ai_settings ADD COLUMN models_json TEXT NOT NULL DEFAULT '[]'")
        expense_schema = db.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expenses'").fetchone()[0]
        if "CHECK (status IN" in expense_schema:
            # PRAGMA foreign_keys 只能在事务外切换；重建期间需保留现有 allocations 引用。
            db.commit()
            db.execute("PRAGMA foreign_keys = OFF")
            db.execute("""CREATE TABLE expenses_new (
                id TEXT PRIMARY KEY, expense_date TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
                merchant TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'SUBMITTED', created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )""")
            db.execute("INSERT INTO expenses_new (id, expense_date, amount_minor, merchant, category, status, created_at) SELECT id, expense_date, amount_minor, merchant, category, status, created_at FROM expenses")
            db.execute("DROP TABLE expenses")
            db.execute("ALTER TABLE expenses_new RENAME TO expenses")
        allocation_foreign_keys = list(db.execute("PRAGMA foreign_key_list(allocations)"))
        allocation_expense_target = next((row[2] for row in allocation_foreign_keys if row[3] == "expense_id"), None)
        if allocation_expense_target != "expenses":
            # 早期状态迁移曾重命名 expenses，SQLite 保留了 allocations 的旧引用。
            # 重建 allocations 只修正外键目标，不改变已有关联记录。
            db.commit()
            db.execute("PRAGMA foreign_keys = OFF")
            db.execute("""CREATE TABLE allocations_new (
                id TEXT PRIMARY KEY, expense_id TEXT NOT NULL REFERENCES expenses(id), invoice_id TEXT NOT NULL REFERENCES invoices(id),
                amount_minor INTEGER NOT NULL CHECK (amount_minor > 0), UNIQUE (expense_id, invoice_id)
            )""")
            db.execute("INSERT INTO allocations_new (id, expense_id, invoice_id, amount_minor) SELECT id, expense_id, invoice_id, amount_minor FROM allocations")
            db.execute("DROP TABLE allocations")
            db.execute("ALTER TABLE allocations_new RENAME TO allocations")
            if db.execute("PRAGMA foreign_key_check").fetchone():
                raise RuntimeError("发票关联迁移后数据不完整")
            db.commit()
            db.execute("PRAGMA foreign_keys = ON")
        if db.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("支出表迁移后发票关联不完整")
        # 现有已提交记录仅迁移一次；之后手动设置的已提交状态不能在重启时被覆盖。
        migrated = db.execute("INSERT OR IGNORE INTO migrations (name) VALUES ('submitted-to-not-submitted')")
        if migrated.rowcount:
            db.execute("UPDATE expenses SET status = 'NOT_SUBMITTED' WHERE status = 'SUBMITTED'")
        # 兼容尚未归并的旧状态。
        db.execute("UPDATE expenses SET status = 'SUBMITTED' WHERE status IN ('DRAFT', 'IN_REVIEW', 'RETURNED', 'APPROVED')")
        db.execute("UPDATE expenses SET status = 'NOT_REQUIRED' WHERE status = 'CANCELLED'")
