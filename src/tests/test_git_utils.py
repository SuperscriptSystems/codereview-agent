import pytest
from git import Repo
from code_review_agent import git_utils

@pytest.fixture
def test_repo(tmp_path):
    """
    Creates a temporary Git repository for testing purposes.
    - tmp_path is a built-in pytest fixture that provides a temporary directory.
    """
    repo_path = tmp_path / "test_repo"
    repo_path.mkdir()
    
    repo = Repo.init(repo_path)
    
    (repo_path / "app_config.py").write_text("API_KEY = '123'")
    (repo_path / ".gitignore").write_text("__pycache__")
    repo.index.add(["app_config.py", ".gitignore"])
    repo.index.commit("Initial commit")
    base_commit = repo.head.commit
    
    (repo_path / "main.py").write_text("import app_config\n\nprint(app_config.API_KEY)")
    (repo_path / "app_config.py").write_text("API_KEY = '456' # Updated")
    repo.index.add(["main.py", "app_config.py"])
    repo.index.commit("Add main file and update config")
    head_commit = repo.head.commit
    
    return repo_path, base_commit.hexsha, head_commit.hexsha

def test_get_diff(test_repo):

    repo_path, base_ref, head_ref = test_repo
    
    diff = git_utils.get_diff(repo_path, base_ref, head_ref)
    
    assert '+++ b/main.py' in diff
    assert "API_KEY = '456'" in diff
    assert "+print(app_config.API_KEY)" in diff

def test_get_changed_files_content(test_repo):

    repo_path, base_ref, head_ref = test_repo
    diff = git_utils.get_diff(repo_path, base_ref, head_ref)


    content = git_utils.get_changed_files_content(str(repo_path), diff)

    assert "main.py" in content
    assert "app_config.py" in content
    assert content["main.py"] == "import app_config\n\nprint(app_config.API_KEY)"

def test_get_file_structure(test_repo):

    repo_path, _, _ = test_repo
    
    structure = git_utils.get_file_structure(str(repo_path), [], [])

    assert "test_repo/" in structure
    assert "    app_config.py" in structure
    assert "    main.py" in structure
    assert ".gitignore" not in structure