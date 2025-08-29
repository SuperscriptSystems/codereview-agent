import json
import pytest
from unittest.mock import MagicMock, call
from code_review_agent import reviewer
from code_review_agent.models import ReviewResult, CodeIssue

class MockMessage:
    def __init__(self, content):
        self.content = content

class MockChoice:
    def __init__(self, content):
        self.message = MockMessage(content)

class MockChatCompletion:
    def __init__(self, choices):
        self.choices = choices


def test_run_review_generates_correct_prompt_with_focus(mocker):
    """
    Tests that the system prompt is correctly formatted based on focus_areas and review_rules.
    """

    mock_response = MockChatCompletion(choices=[MockChoice(content="[]")])
    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.return_value = mock_response
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)
    mocker.patch('code_review_agent.git_utils.create_annotated_file', return_value="annotated content")

    focus_areas_to_test = ["Security", "Performance"]
    custom_rules_to_test = ["Custom rule 1"]

    # Act
    reviewer.run_review(
        changed_files_map={"main.py": "diff content here"},
        final_context_content={"main.py": "full content here"},
        jira_details="",
        review_rules=custom_rules_to_test,
        llm_config={},
        focus_areas=focus_areas_to_test
    )

    mock_llm_client.chat.completions.create.assert_called_once()
    call_args = mock_llm_client.chat.completions.create.call_args
    messages = call_args.kwargs['messages']
    system_prompt = messages[0]['content']
    
    assert "FOCUS:" in system_prompt
    assert "Security, Performance" in system_prompt
    assert "Custom rule 1" in system_prompt


def test_run_review_with_issues_found(mocker):
    """
    Tests the reviewer's logic when the LLM successfully returns valid issues.
    """

    mock_issues_json = json.dumps([
        {"line_number": 10, "issue_type": "LogicError", "comment": "Test comment", "suggestion": "Test suggestion"}
    ])
    mock_response = MockChatCompletion(choices=[MockChoice(content=mock_issues_json)])
    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.return_value = mock_response
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)
    mocker.patch('code_review_agent.git_utils.create_annotated_file', return_value="annotated content")


    review_results = reviewer.run_review(
        changed_files_map={"main.py": "diff"},
        final_context_content={"main.py": "content"},
        jira_details="",
        review_rules=[],
        llm_config={},
        focus_areas=["LogicError"]
    )

    assert "main.py" in review_results
    assert not review_results["main.py"].is_ok()
    assert len(review_results["main.py"].issues) == 1
    assert review_results["main.py"].issues[0].comment == "Test comment"


def test_run_review_handles_malformed_json_response(mocker):
    """
    Tests that the reviewer gracefully handles a non-JSON response from the LLM.
    """
    mock_response = MockChatCompletion(choices=[MockChoice(content="This is not a valid JSON")])
    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.return_value = mock_response
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)
    mocker.patch('code_review_agent.git_utils.create_annotated_file', return_value="annotated content")

    review_results = reviewer.run_review(
        changed_files_map={"main.py": "diff"},
        final_context_content={"main.py": "content"},
        jira_details="",
        review_rules=[],
        llm_config={},
        focus_areas=["LogicError"]
    )

    assert "main.py" in review_results
    assert review_results["main.py"].is_ok()
    assert len(review_results["main.py"].issues) == 0

def test_run_review_handles_api_error(mocker):
    """
    Tests that the reviewer gracefully handles an API error from the LLM client.
    """
    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.side_effect = Exception("API connection timed out")
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)
    mocker.patch('code_review_agent.git_utils.create_annotated_file', return_value="annotated content")
    

    review_results = reviewer.run_review(
        changed_files_map={"main.py": "diff"},
        final_context_content={"main.py": "content"},
        jira_details="",
        review_rules=[],
        llm_config={},
        focus_areas=["LogicError"]
    )


    assert "main.py" in review_results
    assert review_results["main.py"].is_ok()
    assert len(review_results["main.py"].issues) == 0