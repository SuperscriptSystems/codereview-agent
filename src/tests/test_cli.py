import pytest
import yaml
from typer.testing import CliRunner
from unittest.mock import MagicMock

from code_review_agent.cli import app, prioritize_changed_files, filter_test_files
from code_review_agent.models import ContextRequirements, ReviewResult

runner = CliRunner()

@pytest.fixture
def mock_dependencies(mocker):
    """Mocks all external and internal dependencies for CLI tests."""
    
    mocker.patch('code_review_agent.git_utils.get_diff', return_value="diff text")
    mocker.patch('code_review_agent.git_utils.get_commit_messages', return_value="commit messages")
    mocker.patch('code_review_agent.cli.PatchSet', return_value=[MagicMock(target_file='b/main.py')])
    mocker.patch('code_review_agent.git_utils.get_file_content', return_value="file content")
    mocker.patch('code_review_agent.git_utils.find_files_by_names', return_value=["found_dep.py"])
    mocker.patch('code_review_agent.git_utils.get_file_structure', return_value="project structure")

    mocker.patch('code_review_agent.context_builder.determine_context', return_value=ContextRequirements(
        required_additional_files=[], is_sufficient=True, reasoning="Sufficient."
    ))
    mocker.patch('code_review_agent.reviewer.run_review', return_value={})


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

def test_prioritize_changed_files():
    """Tests that the file prioritization logic works correctly."""
    files_map = {
        "src/controller.js": "...",
        "src/service.js": "...",
        "src/interface.js": "...",
        "src/style.css": "..."
    }
    
    tiers = prioritize_changed_files(files_map)
    
    assert "src/interface.js" in tiers[0]
    assert "src/service.js" in tiers[0]
    assert "src/controller.js" in tiers[1]
    assert "src/style.css" in tiers[2]


def test_review_command_full_flow(mocker, mock_dependencies, tmp_path):
    """
    An integration test for the `review` command, ensuring all steps are called.
    """

    mock_filter = mocker.patch('code_review_agent.cli.filter_test_files', return_value={'main.py': '...'})
    mock_prioritize = mocker.patch('code_review_agent.cli.prioritize_changed_files', return_value=[['main.py'], [], []])
    mock_determine_context = mocker.patch('code_review_agent.context_builder.determine_context', return_value=ContextRequirements(
        required_additional_files=[], is_sufficient=True, reasoning="Sufficient."
    ))
    mock_run_review = mocker.patch('code_review_agent.reviewer.run_review', return_value={})

    result = runner.invoke(app, ["--repo-path", str(tmp_path)])
    

    assert result.exit_code == 0, result.output
    
    mock_filter.assert_called_once()
    mock_prioritize.assert_called_once()
    mock_determine_context.assert_called_once()
    mock_run_review.assert_called_once()