import json
import pytest
from unittest.mock import MagicMock
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
    Tests that the system prompt is correctly formatted based on focus_areas.
    """
    
    mock_response = MockChatCompletion(choices=[MockChoice(content="[]")])
    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.return_value = mock_response
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)

    focus_areas_to_test = ["Security", "Performance"]
    
    reviewer.run_review(
        changed_files_map={"main.py": "diff"},
        final_context_content={"main.py": "content"},
        review_rules=["Custom rule 1"],
        llm_config={},
        focus_areas=focus_areas_to_test
    )

    mock_llm_client.chat.completions.create.assert_called_once()
    call_args = mock_llm_client.chat.completions.create.call_args
    messages = call_args.kwargs['messages']
    system_prompt = messages[0]['content']

    assert "You are an expert AI code review assistant" in system_prompt
    assert "BEHAVIORAL RULES (MOST IMPORTANT)" in system_prompt
    
    assert "Security" in system_prompt
    assert "Performance" in system_prompt

    assert "CUSTOM RULES" in system_prompt
    assert "Custom rule 1" in system_prompt


def test_run_review_with_issues_found(mocker):
    mock_issues_json = json.dumps([{"line_number": 10, "issue_type": "LogicError", "comment": "Test comment", "suggestion": "Test suggestion"}])
    mock_response = MockChatCompletion(choices=[MockChoice(content=mock_issues_json)])
    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.return_value = mock_response
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)

    review_results = reviewer.run_review(
        changed_files_map={"main.py": "diff"},
        final_context_content={"main.py": "content"},
        review_rules=[],
        llm_config={},
        focus_areas=["LogicError"]
    )
    assert not review_results["main.py"].is_ok()
    assert review_results["main.py"].issues[0].comment == "Test comment"

def test_run_review_handles_malformed_json_response(mocker):
    mock_response = MockChatCompletion(choices=[MockChoice(content="not json")])
    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.return_value = mock_response
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)
    
    review_results = reviewer.run_review(
        changed_files_map={"main.py": "diff"},
        final_context_content={"main.py": "content"},
        review_rules=[],
        llm_config={},
        focus_areas=["LogicError"]
    )
    assert review_results["main.py"].is_ok()