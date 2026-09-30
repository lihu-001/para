"""AI provider model catalog and per-request model selection tests."""

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main


class AiModelApiTest(unittest.TestCase):
    def setUp(self):
        original_connect = main.connect

        @contextmanager
        def closed_connection():
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

    def configure(self, **overrides):
        payload = {"base_url": "https://provider.example/v1", "model": "alpha", "api_key": "saved-secret", "retention": "keep", "models": ["alpha", "beta"], **overrides}
        response = self.client.put("/api/ai/settings", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_discovers_models_with_entered_key_and_does_not_leak_saved_key_to_other_url(self):
        self.configure()
        seen = {}

        class Response:
            def raise_for_status(self):
                return None

            def json(self):
                return {"data": [{"id": "new-a"}, {"id": "new-a"}, {"id": "new-b"}]}

        def get(url, **kwargs):
            seen.update(url=url, kwargs=kwargs)
            return Response()

        with patch.object(main.httpx, "get", side_effect=get):
            response = self.client.post("/api/ai/models", json={"base_url": "https://other.example/v1", "api_key": "entered-secret"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"models": ["new-a", "new-b"]})
        self.assertEqual(seen["url"], "https://other.example/v1/models")
        self.assertEqual(seen["kwargs"]["headers"], {"Authorization": "Bearer entered-secret"})

        with patch.object(main.httpx, "get") as request:
            missing_key = self.client.post("/api/ai/models", json={"base_url": "https://other.example/v1"})
        self.assertEqual(missing_key.status_code, 422)
        request.assert_not_called()

    def test_settings_persist_catalog_without_returning_api_key(self):
        result = self.configure()
        self.assertEqual(result["models"], ["alpha", "beta"])
        self.assertNotIn("api_key", result)
        self.assertEqual(self.client.get("/api/ai/settings").json()["models"], ["alpha", "beta"])

    def test_agent_model_override_is_request_scoped_and_catalog_validated(self):
        self.configure()
        conversation = self.client.post("/api/agent/conversations", json={}).json()
        calls = []

        def fake_run(user_text, history, settings, execute_tool):
            calls.append((settings["model"], settings["models"], conversation["id"], len(history)))
            return {"content": "ok", "tool_events": [], "pending_action": None, "transcript": []}

        with patch.object(main, "run_agent", side_effect=fake_run):
            response = self.client.post(f"/api/agent/conversations/{conversation['id']}/messages", data={"content": "hello", "model": "beta"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(calls[0][:2], ("beta", ["alpha", "beta"]))
        self.assertEqual(self.client.get(f"/api/agent/conversations/{conversation['id']}").status_code, 200)
        self.assertEqual(self.client.post(f"/api/agent/conversations/{conversation['id']}/messages", data={"content": "hello", "model": "not-saved"}).status_code, 422)
        self.assertEqual(self.client.get("/api/ai/settings").json()["model"], "alpha")

    def test_legacy_empty_catalog_allows_saved_default_only(self):
        self.configure(models=[])
        conversation = self.client.post("/api/agent/conversations", json={}).json()
        with patch.object(main, "run_agent", return_value={"content": "ok", "tool_events": [], "pending_action": None, "transcript": []}):
            self.assertEqual(self.client.post(f"/api/agent/conversations/{conversation['id']}/messages", data={"content": "hello", "model": "alpha"}).status_code, 200)
            self.assertEqual(self.client.post(f"/api/agent/conversations/{conversation['id']}/messages", data={"content": "hello", "model": "beta"}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
