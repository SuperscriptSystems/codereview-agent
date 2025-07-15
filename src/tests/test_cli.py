from typer.testing import CliRunner
from code_review_agent.cli import app
from code_review_agent.models import ContextRequirements, ReviewResult, CodeIssue

runner = CliRunner()

def test_review_command_end_to_end(mocker):

    mocker.patch('code_review_agent.git_utils.get_diff', return_value="diff --git a/main.py b/main.py")
    mocker.patch('code_review_agent.git_utils.get_commit_messages', return_value="feat: new feature")
    mocker.patch('code_review_agent.git_utils.get_changed_files_content', return_value={"main.py": "x=1"})
    mocker.patch('code_review_agent.git_utils.get_file_structure', return_value="src/\n main.py")
    mocker.patch('code_review_agent.git_utils.get_file_content', return_value="x=1")


    mock_context_response = ContextRequirements(
        required_additional_files=[],
        is_sufficient=True,
        reasoning="Initial files are enough."
    )
    mocker.patch('code_review_agent.context_builder.determine_context', return_value=mock_context_response)


    mock_review_response = ReviewResult(issues=[
        CodeIssue(line_number=1, issue_type="CodeStyle", comment="Add spaces around '='", suggestion="x = 1")
    ])
    mocker.patch('code_review_agent.reviewer.run_review', return_value={"main.py": mock_review_response})

    result = runner.invoke(app, ["--repo-path", "."])

    assert result.exit_code == 0
    assert "🚀 Starting review" in result.stdout
    assert "✅ Context is sufficient." in result.stdout
    assert "🚨 Issues in `main.py`:" in result.stdout
    assert "Add spaces around '='" in result.stdout
    assert "💡 Suggestion:" in result.stdout