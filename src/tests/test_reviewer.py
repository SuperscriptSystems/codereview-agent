import json
from unittest.mock import MagicMock
from code_review_agent import reviewer

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
        changed_files_to_review=["main.py"],
        full_context_content={"main.py": "x = 5"},
        review_rules=["Custom rule 1"],
        llm_config={"provider": "openai"},
        focus_areas=focus_areas_to_test
    )

    mock_llm_client.chat.completions.create.assert_called_once()
    call_args = mock_llm_client.chat.completions.create.call_args
    messages = call_args.kwargs['messages']
    system_prompt = messages[0]['content']
    
    assert "Your primary focus for this review" in system_prompt
    assert "Security, Performance" in system_prompt
    assert "Custom rule 1" in system_prompt


def test_run_review_with_issues_found(mocker):
    """
    Tests the reviewer's logic when the LLM successfully returns issues.
    """

    mock_issues_json = json.dumps([
      {
        "line_number": 10,
        "issue_type": "LogicError",
        "comment": "Variable 'x' is not descriptive.",
        "suggestion": "use a more descriptive name"
      }
    ])

    mock_response = MockChatCompletion(choices=[MockChoice(content=mock_issues_json)])
    
    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.return_value = mock_response
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)
    

    review_results = reviewer.run_review(
        changed_files_to_review=["main.py"],
        full_context_content={"main.py": "x = 5"},
        review_rules=[],
        llm_config={"provider": "openai"},
        focus_areas=["LogicError"]
    )

    assert "main.py" in review_results
    assert not review_results["main.py"].is_ok()
    assert len(review_results["main.py"].issues) == 1
    assert review_results["main.py"].issues[0].comment == "Variable 'x' is not descriptive."


def test_run_review_handles_malformed_json_response(mocker):
        """
        Tests that the reviewer gracefully handles a non-JSON response from the LLM.
        """
        malformed_content = "I am a teapot, not a JSON array."
        mock_response = MockChatCompletion(choices=[MockChoice(content=malformed_content)])
        
        mock_llm_client = MagicMock()
        mock_llm_client.chat.completions.create.return_value = mock_response
        mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)
        
        review_results = reviewer.run_review(
            changed_files_to_review=["main.py"],
            full_context_content={"main.py": "x = 5"},
            review_rules=[],
            llm_config={"provider": "openai"},
            focus_areas=["LogicError"]
        )


        assert "main.py" in review_results
        assert review_results["main.py"].is_ok()
        assert len(review_results["main.py"].issues) == 0