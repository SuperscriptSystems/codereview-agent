from typer.testing import CliRunner
from code_review_agent.cli import app
from code_review_agent.models import ContextRequirements, ReviewResult, CodeIssue

runner = CliRunner()

def test_review_iterative_context_build(mocker):



    mocker.patch('code_review_agent.git_utils.get_diff', return_value="diff --git a/service.py b/service.py")
    mocker.patch('code_review_agent.git_utils.get_commit_messages', return_value="refactor: update user logic")
    mocker.patch('code_review_agent.git_utils.get_changed_files_from_diff', return_value=["service.py"])
    mocker.patch(
        'code_review_agent.git_utils.get_file_content', 
        side_effect=lambda _, path: {"service.py": "import db_client", "db_client.py": "class DBClient:"}.get(path, "")
    )

    mocker.patch('code_review_agent.git_utils.find_files_by_names', return_value=["db_client.py"])
    mocker.patch('code_review_agent.git_utils.get_file_structure_from_paths', return_value="- service.py\n- db_client.py")


    mock_context_response_1 = ContextRequirements(
        required_additional_files=['db_client'],
        is_sufficient=False,
        reasoning="Need to see the db_client implementation."
    )
    mock_context_response_2 = ContextRequirements(
        required_additional_files=[],
        is_sufficient=True,
        reasoning="Context is now sufficient with db_client."
    )
    mocker.patch('code_review_agent.context_builder.determine_context', side_effect=[mock_context_response_1, mock_context_response_2])
    
    mock_review_response = ReviewResult(issues=[
        CodeIssue(line_number=1, issue_type="LogicError", comment="DB client is not used correctly.", suggestion=None)
    ])
    mocker.patch('code_review_agent.reviewer.run_review', return_value={"service.py": mock_review_response})

    result = runner.invoke(app, ["--repo-path", "."])

    assert result.exit_code == 0, result.stdout
    assert "--- Context Building Iteration 1/3 ---" in result.stdout
    assert "🧠 Agent reasoning: Need to see the db_client implementation." in result.stdout
    assert "🔎 Searching for requested files: ['db_client']" in result.stdout
    assert "➕ Adding 1 new files to context: ['db_client.py']" in result.stdout
    assert "--- Context Building Iteration 2/3 ---" in result.stdout
    assert "✅ Context is now sufficient." in result.stdout
    assert "--- Starting Code Review Phase ---" in result.stdout
    assert "🚨 Issues in `service.py`:" in result.stdout
    assert "DB client is not used correctly." in result.stdout

def test_review_context_sufficient_immediately(mocker):
    mocker.patch('code_review_agent.git_utils.get_diff', return_value="diff --git a/README.md b/README.md")
    mocker.patch('code_review_agent.git_utils.get_commit_messages', return_value="docs: update readme")
    mocker.patch('code_review_agent.git_utils.get_changed_files_from_diff', return_value=["README.md"])
    mocker.patch('code_review_agent.git_utils.get_file_content', return_value="New content")

    mock_context_response = ContextRequirements(
        required_additional_files=[],
        is_sufficient=True,
        reasoning="The change is only in a markdown file, no code context needed."
    )
    mocker.patch('code_review_agent.context_builder.determine_context', return_value=mock_context_response)

    mock_review_response = ReviewResult(issues=[])
    mocker.patch('code_review_agent.reviewer.run_review', return_value={"README.md": mock_review_response})
    

    result = runner.invoke(app, ["--repo-path", "."])


    assert result.exit_code == 0, result.stdout
    assert "--- Context Building Iteration 1/3 ---" in result.stdout
    assert "✅ Context is now sufficient." in result.stdout
    assert "--- Context Building Iteration 2/3 ---" not in result.stdout
    assert "🎉 Great job! No issues found." in result.stdout