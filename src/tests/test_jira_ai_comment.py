import os
import json
import pytest

from code_review_agent.jira_client import add_comment

TASK_ID = "EX-999"

@pytest.fixture(autouse=True)
def jira_env(monkeypatch):
    monkeypatch.setenv("JIRA_URL", "https://example.atlassian.net")
    monkeypatch.setenv("JIRA_USER_EMAIL", "bot@example.com")
    monkeypatch.setenv("JIRA_API_TOKEN", "tok")
    yield

def make_response(status, json_data=None, text=None):
    class R:
        def __init__(self):
            self.status_code = status
            self._json = json_data
            self.text = text if text is not None else (json.dumps(json_data) if json_data else "")
        def json(self):
            return self._json
    return R()

def test_add_comment_replaces_previous(monkeypatch):
    calls = {"get": [], "delete": [], "post": []}

    def mock_get(url, *a, **k):
        calls["get"].append(url)
        if url.endswith("/myself"):
            return make_response(200, {"accountId": "acct-1"})
        if f"/issue/{TASK_ID}/comment" in url:
            # Два старі коментарі (legacy + новий формат)
            return make_response(200, {
                "comments": [
                    {"id": "10", "author": {"accountId": "acct-1"}, "body": "🤖 AI Assessment\nOld body"},
                    {"id": "11", "author": {"accountId": "acct-1"}, "body": "*🤖 AI Assessment Complete*\nPrevious"}
                ]
            })
        return make_response(404, text="not used")

    def mock_delete(url, *a, **k):
        calls["delete"].append(url)
        return make_response(204)

    def mock_post(url, json=None, *a, **k):
        calls["post"].append((url, json))
        # Перший (v3) успішний → v2 не викликається
        return make_response(201, {"id": "900"})

    monkeypatch.setattr("code_review_agent.jira_client.requests.get", mock_get)
    monkeypatch.setattr("code_review_agent.jira_client.requests.delete", mock_delete)
    monkeypatch.setattr("code_review_agent.jira_client.requests.post", mock_post)

    add_comment(TASK_ID, "Relevance: *85%*\n\nJustification: test")

    # Перевірки
    assert any(u.endswith("/myself") for u in calls["get"])
    assert len(calls["delete"]) == 2          # обидва старі видалені
    assert len(calls["post"]) == 1            # лише один новий коментар
    posted_body = calls["post"][0][1]["body"]
    assert posted_body.startswith("*🤖 AI Assessment Complete*")
    assert posted_body.count("*🤖 AI Assessment Complete*") == 1  # без дублю

def test_add_comment_no_duplicate_marker(monkeypatch):
    calls = {"get": [], "delete": [], "post": []}

    def mock_get(url, *a, **k):
        calls["get"].append(url)
        if url.endswith("/myself"):
            return make_response(200, {"accountId": "acct-1"})
        if f"/issue/{TASK_ID}/comment" in url:
            return make_response(200, {"comments": []})
        return make_response(404)

    def mock_delete(url, *a, **k):
        calls["delete"].append(url)
        return make_response(204)

    def mock_post(url, json=None, *a, **k):
        calls["post"].append((url, json))
        return make_response(201, {"id": "901"})

    monkeypatch.setattr("code_review_agent.jira_client.requests.get", mock_get)
    monkeypatch.setattr("code_review_agent.jira_client.requests.delete", mock_delete)
    monkeypatch.setattr("code_review_agent.jira_client.requests.post", mock_post)

    # Уже передаємо з маркером
    add_comment(TASK_ID, "*🤖 AI Assessment Complete*\n\nRelevance: 100%")

    assert len(calls["delete"]) == 0
    assert len(calls["post"]) == 1
    body = calls["post"][0][1]["body"]
    # Маркер не додано вдруге
    assert body.startswith("*🤖 AI Assessment Complete*")
    assert body.count("*🤖 AI Assessment Complete*") == 1