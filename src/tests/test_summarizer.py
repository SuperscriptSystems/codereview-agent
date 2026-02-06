
import json
import pytest
from unittest.mock import MagicMock
from code_review_agent.summarizer import summarize_changes_for_jira
from code_review_agent.models import MergeSummary

@pytest.fixture
def mock_llm_client(monkeypatch):
    mock_client = MagicMock()
    # Mocking get_client in the module where it is imported (summarizer.py)
    # The import in summarizer.py is `from .llm_client import get_client`
    # So we need to patch `code_review_agent.summarizer.get_client`
    monkeypatch.setattr('code_review_agent.summarizer.get_client', lambda config: mock_client)
    return mock_client

def test_summarize_changes_for_jira_success(mock_llm_client):
    """
    Tests that summarize_changes_for_jira correctly parses a valid JSON response from the LLM.
    """
    # Mock data
    jira_details = "Jira Task: PROJ-123"
    commit_messages = "feat: added login"
    diff_summary = {"files_changed": [{"path": "auth.py", "insertions": 10, "deletions": 2}]}
    llm_config = {"models": {"summarizer": "gpt-4"}}

    # Expected LLM response
    expected_summary_data = {
        "relevance_score": 90,
        "relevance_justification": "The changes directly address the task.",
        "commit_summary": "Implemented login functionality.",
        "db_tables_created": [],
        "db_tables_modified": [],
        "api_endpoints_added": [],
        "api_endpoints_modified": []
    }
    
    mock_response_content = json.dumps(expected_summary_data)
    
    # Configure mock
    mock_choice = MagicMock()
    mock_choice.message.content = mock_response_content
    mock_llm_client.chat.completions.create.return_value.choices = [mock_choice]

    # Run function
    result = summarize_changes_for_jira(jira_details, commit_messages, diff_summary, llm_config)

    # Assertions
    assert result is not None
    assert isinstance(result, MergeSummary)
    assert result.relevance_score == 90
    assert result.relevance_justification == "The changes directly address the task."
    
    # Verify LLM call arguments to ensure JSON mode was enabled
    mock_llm_client.chat.completions.create.assert_called_once()
    call_kwargs = mock_llm_client.chat.completions.create.call_args[1]
    assert call_kwargs['response_format'] == {"type": "json_object"}
    assert "MergeSummary" in str(json.dumps(MergeSummary.model_json_schema())) # Check implicit presence of schema

def test_summarize_changes_for_jira_invalid_json(mock_llm_client):
    """
    Tests that summarize_changes_for_jira returns None when LLM returns invalid JSON.
    """
    # Mock data
    jira_details = "Jira Task: PROJ-123"
    commit_messages = "feat: added login"
    diff_summary = {"files_changed": []}
    llm_config = {}

    # Invalid JSON response
    mock_response_content = "This is not JSON"
    
    # Configure mock
    mock_choice = MagicMock()
    mock_choice.message.content = mock_response_content
    mock_llm_client.chat.completions.create.return_value.choices = [mock_choice]

    # Run function
    result = summarize_changes_for_jira(jira_details, commit_messages, diff_summary, llm_config)

    # Assertions
    assert result is None
