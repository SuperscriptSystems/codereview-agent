from unittest.mock import MagicMock
from code_review_agent import reviewer
from code_review_agent.models import ReviewResult, CodeIssue

def test_run_review_with_issues(mocker):
    """
    Tests the reviewer when the LLM finds issues.
    - mocker is a fixture from pytest-mock that helps create mocks.
    """
    mock_issue = CodeIssue(
        line_number=10,
        issue_type="CodeStyle",
        comment="Variable 'x' is not descriptive.",
        suggestion="use a more descriptive name like 'item_count'"
    )
    mock_review_result = ReviewResult(issues=[mock_issue])


    mock_llm_client = MagicMock()
    mock_llm_client.chat.completions.create.return_value = mock_review_result
    mocker.patch('code_review_agent.reviewer.get_client', return_value=mock_llm_client)


    review_results = reviewer.run_review(
        changed_files_to_review=["main.py"],
        full_context_content={"main.py": "x = 5"},
        review_rules=[],
        llm_config={"provider": "openai"}
    )

    assert "main.py" in review_results
    assert not review_results["main.py"].is_ok()
    assert len(review_results["main.py"].issues) == 1
    assert review_results["main.py"].issues[0].comment == "Variable 'x' is not descriptive."

    mock_llm_client.chat.completions.create.assert_called_once()