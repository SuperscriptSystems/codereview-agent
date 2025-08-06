import pytest
import git
import yaml
from typer.testing import CliRunner
from unittest.mock import MagicMock

from code_review_agent.cli import app
from code_review_agent.models import ContextRequirements, ReviewResult, CodeIssue

runner = CliRunner()

@pytest.fixture
def create_test_config(tmp_path):
    def _create_config(data):
        config_path = tmp_path / ".codereview.yml"
        with open(config_path, "w") as f:
            yaml.dump(data, f)
        return str(tmp_path)
    return _create_config

@pytest.fixture
def mock_all_dependencies(mocker):
    """Mocks all external dependencies for CLI tests."""
    
    mocker.patch('git.Repo') 
    mocker.patch('code_review_agent.git_utils.get_diff', return_value="diff text")
    mocker.patch('code_review_agent.git_utils.get_commit_messages', return_value="commit messages")
    mocker.patch('code_review_agent.cli.io')

    mock_patch_set = mocker.patch('code_review_agent.cli.PatchSet')
    mock_patched_file = MagicMock()
    mock_patched_file.target_file = 'b/main.py' 
    mock_patched_file.__str__.return_value = "diff for main.py"
    mock_patch_set.return_value = [mock_patched_file]
    
    mocker.patch('code_review_agent.git_utils.get_file_content', return_value="full file content")
    mocker.patch('code_review_agent.context_builder.determine_context', return_value=ContextRequirements(
        required_additional_files=[], is_sufficient=True, reasoning="Sufficient for test."
    ))
    return mocker.patch('code_review_agent.reviewer.run_review', return_value={"main.py": ReviewResult(issues=[])})


def test_focus_logic_with_cli_priority(mock_all_dependencies, create_test_config):
    """Tests that --focus from CLI has the highest priority."""
    repo_path = create_test_config({'review_focus': ['Security']})
    result = runner.invoke(app, ["--repo-path", repo_path, "--focus", "CodeStyle"])

    assert result.exit_code == 0, result.output
    assert "Using focus areas from command line arguments" in result.output
    
    kwargs = mock_all_dependencies.call_args.kwargs
    assert set(kwargs["focus_areas"]) == {"CodeStyle"}

def test_focus_logic_with_config_file(mock_all_dependencies, create_test_config):
    """Tests that focus is taken from .codereview.yml if CLI is not specified."""
    repo_path = create_test_config({'review_focus': ['Security', 'Performance']})
    result = runner.invoke(app, ["--repo-path", repo_path])

    assert result.exit_code == 0, result.output
    assert "Using focus areas from .codereview.yml config file" in result.output
    
    kwargs = mock_all_dependencies.call_args.kwargs
    assert set(kwargs["focus_areas"]) == {"Security", "Performance"}

def test_focus_logic_with_default(mock_all_dependencies, tmp_path):
    """Tests that the agent defaults to 'LogicError' only."""
    result = runner.invoke(app, ["--repo-path", str(tmp_path)])
    
    assert result.exit_code == 0, result.output
    assert "No focus specified. Checking for 'LogicError' by default" in result.output
    
    kwargs = mock_all_dependencies.call_args.kwargs
    assert set(kwargs["focus_areas"]) == {"LogicError"}