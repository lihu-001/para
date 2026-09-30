import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main


class InvoiceLedgerTest(unittest.TestCase):
    def test_parse_confirm_page_and_delete_linked_invoice(self):
        original_connect = main.connect

        @contextmanager
        def closed_connection():
            connection = original_connect()
            try:
                with connection:
                    yield connection
            finally:
                connection.close()

        parsed = {
            "invoice_number": "INV-01", "issue_date": "2026-09-29", "total_amount_minor": 1250,
            "seller_name": "销售公司", "seller_tax_number": "SELLER123",
            "buyer_name": "购买公司", "buyer_tax_number": "BUYER456",
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(main, "DB", Path(directory) / "test.sqlite3"), patch.object(main, "UPLOAD_DIR", Path(directory) / "invoices"), patch.object(main, "AGENT_UPLOAD_DIR", Path(directory) / "agent"), patch.object(main, "connect", closed_connection), patch.object(main, "parse_invoice_images", return_value=parsed):
            with TestClient(main.app) as client:
                response = client.post("/api/invoices/parse", files={"file": ("invoice.png", b"image", "image/png")})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["fields"]["buyer_tax_number"], "BUYER456")
                token = response.json()["token"]
                confirmed = client.post("/api/invoices/confirm", json={
                    "issue_date": parsed["issue_date"], "amount_minor": 1250, "seller": parsed["seller_name"],
                    "seller_tax_number": parsed["seller_tax_number"], "buyer_name": parsed["buyer_name"],
                    "buyer_tax_number": parsed["buyer_tax_number"], "invoice_number": parsed["invoice_number"],
                    "source_pdf": token,
                })
                self.assertEqual(confirmed.status_code, 201)
                invoice = confirmed.json()
                self.assertEqual((main.UPLOAD_DIR / invoice["source_pdf"]).read_bytes(), b"image")
                with main.connect() as db:
                    for index in range(11):
                        db.execute("INSERT INTO invoices (id, issue_date, amount_minor, seller) VALUES (?, '2026-09-01', 100, '旧销售方')", (f"old-{index}",))
                first = client.get("/api/invoices", params={"page": 1, "page_size": 10}).json()
                second = client.get("/api/invoices", params={"page": 2, "page_size": 10}).json()
                self.assertEqual((first["total"], len(first["items"]), len(second["items"])), (12, 10, 2))
                self.assertEqual(first["items"][0]["buyer_name"], "购买公司")
                self.assertEqual(first["items"][0]["seller_tax_number"], "SELLER123")
                self.assertEqual(client.get("/api/invoices", params={"page": 1, "search": "BUYER456"}).json()["total"], 1)
                self.assertEqual(client.get("/api/invoices", params={"page": 1, "search": "购买公司"}).json()["total"], 1)
                self.assertEqual(client.get("/api/invoices", params={"page": 0}).status_code, 422)
                expense = client.post("/api/expenses", json={"expense_date": "2026-09-29", "amount_minor": 1250, "merchant": "采购", "category": "办公用品"}).json()
                self.assertEqual(client.post("/api/allocations", json={"expense_id": expense["id"], "invoice_ids": [invoice["id"]]}).status_code, 201)
                self.assertEqual(client.delete(f"/api/invoices/{invoice['id']}").status_code, 200)
                self.assertEqual(client.get("/api/allocations").json(), [])
                self.assertEqual(client.get("/api/summary").json()["uncovered_total"], 1250)
                self.assertFalse((main.UPLOAD_DIR / invoice["source_pdf"]).exists())
                self.assertEqual(client.delete(f"/api/invoices/{invoice['id']}").status_code, 404)
                self.assertEqual(client.get("/api/invoices", params={"page": 1, "search": "购买公司"}).json()["total"], 0)


if __name__ == "__main__":
    unittest.main()
