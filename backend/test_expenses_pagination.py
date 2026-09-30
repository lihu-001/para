import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main


class ExpensePaginationTest(unittest.TestCase):
    def test_pages_search_and_validation(self):
        original_connect = main.connect

        @contextmanager
        def closed_connection():
            connection = original_connect()
            try:
                with connection:
                    yield connection
            finally:
                connection.close()

        with tempfile.TemporaryDirectory() as directory, patch.object(main, "DB", Path(directory) / "test.sqlite3"), patch.object(main, "connect", closed_connection):
            with TestClient(main.app) as client:
                for index in range(12):
                    response = client.post("/api/expenses", json={
                        "expense_date": "2026-09-29",
                        "amount_minor": 100 + index,
                        "merchant": f"商户{index:02d}" if index != 11 else "折扣%商户",
                        "category": "餐饮" if index % 2 else "交通出行",
                    })
                    self.assertEqual(response.status_code, 201)

                first = client.get("/api/expenses", params={"page": 1, "page_size": 10}).json()
                second = client.get("/api/expenses", params={"page": 2, "page_size": 10}).json()
                self.assertEqual(first["total"], 12)
                self.assertEqual(len(first["items"]), 10)
                self.assertEqual(len(second["items"]), 2)
                self.assertEqual(len({row["id"] for row in first["items"] + second["items"]}), 12)

                by_merchant = client.get("/api/expenses", params={"search": "商户03"}).json()
                self.assertEqual(by_merchant["total"], 1)
                self.assertEqual(by_merchant["items"][0]["merchant"], "商户03")
                by_category = client.get("/api/expenses", params={"search": "餐饮", "page_size": 2}).json()
                self.assertEqual(by_category["total"], 6)
                self.assertEqual(len(by_category["items"]), 2)
                literal_percent = client.get("/api/expenses", params={"search": "%"}).json()
                self.assertEqual(literal_percent["total"], 1)
                self.assertEqual(client.get("/api/expenses", params={"page": 0}).status_code, 422)
                self.assertEqual(client.get("/api/expenses", params={"page_size": 51}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
