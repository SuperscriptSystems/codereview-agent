import pytest
import yaml
from typer.testing import CliRunner
from unittest.mock import MagicMock
import os

from code_review_agent.cli import app, filter_test_files, _get_task_id_from_git_info
from code_review_agent.models import ContextRequirements, ReviewResult, CodeIssue

runner = CliRunner()

@pytest.fixture(autouse=True)
def mock_dependencies(mocker):
    """Mocks all external and internal dependencies for CLI tests."""
    mocker.patch('code_review_agent.git_utils.get_diff', return_value="diff text")
    mocker.patch('code_review_agent.git_utils.get_commit_messages', return_value=["feat: new feature"])
    
    mock_patched_file = MagicMock()
    mock_patched_file.target_file = 'b/main.py'
    mocker.patch('code_review_agent.cli.PatchSet', return_value=[mock_patched_file])
    
    mocker.patch('code_review_agent.git_utils.get_file_content', return_value="file content")
    mocker.patch('code_review_agent.git_utils.find_files_by_names', return_value=["found_dep.py"])
    mocker.patch('code_review_agent.git_utils.get_file_structure', return_value="project structure")

    mocker.patch('code_review_agent.context_builder.determine_context', return_value=ContextRequirements(
        required_additional_files=[], is_sufficient=True, reasoning="Sufficient."
    ))
    mocker.patch('code_review_agent.reviewer.run_review', return_value={
        "main.py": ReviewResult(issues=[])
    })
    
    mocker.patch('code_review_agent.jira_client.get_task_details', return_value=None)
    mocker.patch('code_review_agent.jira_client.project_keys', return_value=set())


def test_filter_test_files():
    """Tests that the test file filtering logic works correctly."""
    files_map = {
        "src/services/UserService.cs": "...",
        "src/tests/UserService.Tests.cs": "...",
        "src/spec/component.spec.js": "..."
    }
    keywords = ["test", "tests", "spec"]

    result = filter_test_files(files_map, keywords)
    
    assert "src/services/UserService.cs" in result
    assert "src/tests/UserService.Tests.cs" not in result
    assert "src/spec/component.spec.js" not in result
    assert len(result) == 1

def test_get_task_id_from_git_info(mocker):
    """Tests that the Jira task ID is correctly extracted."""
    mocker.patch.dict(os.environ, {"BITBUCKET_BRANCH": "feature/PROJ-123-my-task"})
    assert _get_task_id_from_git_info(["some message"]) == "PROJ-123"
    
    mocker.patch.dict(os.environ, {"BITBUCKET_BRANCH": "feature/no-task-id"})
    assert _get_task_id_from_git_info(["feat: ABC-456 implement new logic"]) == "ABC-456"

def test_review_command_full_flow(mocker, tmp_path):
    """
    An integration test for the `review` command, ensuring all key functions are called.
    """
    mock_filter = mocker.patch('code_review_agent.cli.filter_test_files', return_value={'main.py': 'diff content'})
    mock_prioritize = mocker.patch('code_review_agent.cli.prioritize_changed_files_with_context_check', return_value=['main.py'])
    mock_run_review = mocker.patch('code_review_agent.reviewer.run_review', return_value={})
    
    result = runner.invoke(app, [
        "--repo-path", str(tmp_path)
    ])
    
    assert result.exit_code == 0, result.stdout
    
    mock_filter.assert_called_once()
    mock_prioritize.assert_called_once()
    mock_run_review.assert_called_once()

def test_prioritize_changed_files_batch_execution(mocker):
    """Tests that prioritization uses batch processing."""
    from code_review_agent.cli import prioritize_changed_files_with_context_check
    
    # Mock the batch function
    mock_batch = mocker.patch('code_review_agent.context_builder.determine_context_batch')
    
    # Setup return values for batch
    # Two files in tier 3 -> one batch call expecting 2 results
    mock_batch.return_value = [
        ContextRequirements(required_additional_files=[], is_sufficient=True, reasoning="Ok1"),
        ContextRequirements(required_additional_files=[], is_sufficient=True, reasoning="Ok2")
    ]
    
    changed_files = {'file1.py': 'diff1', 'file2.py': 'diff2'}
    
    prioritize_changed_files_with_context_check(
        changed_files_map=changed_files,
        commit_messages="msg",
        jira_details="jira",
        final_context_content={},
        full_project_structure="",
        llm_config={},
        repo_path=".",
        filtering_config={}
    )
    
    mock_batch.assert_called()
    # Since both files are tier 3, we expect key 'tier 3' processing triggers one batch call
    assert mock_batch.call_count == 1
    
    # Check arguments: list of dicts
    call_args = mock_batch.call_args[0][0]
    assert len(call_args) == 2
    assert call_args[0]['diff'] == 'diff1'
    assert call_args[1]['diff'] == 'diff2'