import yaml
import pytest
from typer.testing import CliRunner
from code_review_agent.cli import app
from code_review_agent.models import ContextRequirements, ReviewResult


runner = CliRunner()

@pytest.fixture
def create_test_config(tmp_path):
    def _create_config(data):
        config_path = tmp_path / ".codereview.yml"
        with open(config_path, "w") as f:
            yaml.dump(data, f)
        return str(tmp_path)
    return _create_config

@pytest.fixture(autouse=True)
def mock_dependencies(mocker):
    mocker.patch('git.Repo') 
    
    mocker.patch('code_review_agent.git_utils.get_diff', return_value="diff --git a/main.py b/main.py")
    mocker.patch('code_review_agent.git_utils.get_commit_messages', return_value="feat: new feature")
    mocker.patch('code_review_agent.git_utils.get_changed_files_from_diff', return_value=["main.py"])
    mocker.patch('code_review_agent.git_utils.get_file_content', return_value="def main(): pass")
    
    # Мокуємо агентів
    mocker.patch('code_review_agent.context_builder.determine_context', return_value=ContextRequirements(
        required_additional_files=[], is_sufficient=True, reasoning="Sufficient for test."
    ))
    mocker.patch('code_review_agent.reviewer.run_review', return_value={"main.py": ReviewResult(issues=[])})


def test_review_uses_cli_focus_with_highest_priority(mocker, create_test_config):
    repo_path = create_test_config({'review_focus': ['Security']})
    mock_run_review = mocker.patch('code_review_agent.reviewer.run_review', return_value={"main.py": ReviewResult(issues=[])})

    result = runner.invoke(app, ["--repo-path", repo_path, "--focus", "LogicError"])

    assert result.exit_code == 0, result.stdout
    assert "Using focus areas from command line arguments" in result.stdout
    
    mock_run_review.assert_called_once()
    kwargs = mock_run_review.call_args.kwargs
    assert "focus_areas" in kwargs
    assert set(kwargs["focus_areas"]) == {"LogicError"}

def test_review_uses_config_file_focus(mocker, create_test_config):
    repo_path = create_test_config({'review_focus': ['Security', 'LogicError']})
    mock_run_review = mocker.patch('code_review_agent.reviewer.run_review', return_value={"main.py": ReviewResult(issues=[])})

    result = runner.invoke(app, ["--repo-path", repo_path])

    assert result.exit_code == 0, result.stdout
    assert "Using focus areas from .codereview.yml config file" in result.stdout
    
    mock_run_review.assert_called_once()
    kwargs = mock_run_review.call_args.kwargs
    assert "focus_areas" in kwargs
    assert set(kwargs["focus_areas"]) == {"Security", "LogicError"}

def test_review_uses_default_logicerror_focus(mocker, tmp_path):
    """
    Tests that if no focus is specified, the agent defaults to 'LogicError' only.
    """
    mock_run_review = mocker.patch('code_review_agent.reviewer.run_review', return_value={"main.py": ReviewResult(issues=[])})

    result = runner.invoke(app, ["--repo-path", str(tmp_path)])
    
    assert result.exit_code == 0, result.stdout
    assert "🎯 No focus specified. Checking for 'LogicError' by default." in result.stdout

    mock_run_review.assert_called_once()
    kwargs = mock_run_review.call_args.kwargs
    
    assert "focus_areas" in kwargs
    assert set(kwargs["focus_areas"]) == {"LogicError"}