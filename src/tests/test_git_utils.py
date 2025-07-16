import pytest
import os
from git import Repo
from code_review_agent import git_utils

@pytest.fixture
def test_repo(tmp_path):
    """Creates a temporary Git repository for testing."""
    repo_path = tmp_path / "test_repo"
    repo_path.mkdir()
    
    (repo_path / "src" / "services").mkdir(parents=True)
    
    repo = Repo.init(repo_path)
    
    (repo_path / "src" / "config.py").write_text("API_KEY = '123'")
    (repo_path / "src" / "services" / "user_service.py").write_text("class UserService:\n  pass")
    repo.index.add(["src/config.py", "src/services/user_service.py"])
    repo.index.commit("Initial commit")
    base_commit = repo.head.commit
    
    (repo_path / "main.py").write_text("import ...")
    (repo_path / "src" / "config.py").write_text("API_KEY = '456' # Updated")

    repo.index.add(["main.py", "src/config.py"])
    repo.index.commit("Second commit with changes")
    head_commit = repo.head.commit
    
    return str(repo_path), base_commit.hexsha, head_commit.hexsha

def test_get_diff(test_repo):
    repo_path, base_ref, head_ref = test_repo
    diff = git_utils.get_diff(repo_path, base_ref, head_ref)

    assert '+++ b/main.py' in diff
    assert '+++ b/src/config.py' in diff
    assert "+API_KEY = '456' # Updated" in diff 

def test_find_files_by_names(test_repo):

    repo_path, _, _ = test_repo
    names_to_find = ["user_service", "config"]

    found_files = git_utils.find_files_by_names(repo_path, names_to_find, [], [])

    assert set(found_files) == {
        os.path.join('src', 'services', 'user_service.py').replace('\\', '/'),
        os.path.join('src', 'config.py').replace('\\', '/')
    }
    assert len(found_files) == 2

def test_find_files_by_names_no_matches(test_repo):

    repo_path, _, _ = test_repo
    names_to_find = ["non_existent_file", "database"]

    found_files = git_utils.find_files_by_names(repo_path, names_to_find, [], [])

    assert len(found_files) == 0


def test_get_file_structure_from_paths():
    paths = [
        "src/services/user_service.py",
        "main.py",
        "src/config.py"
    ]


    structure = git_utils.get_file_structure_from_paths(paths)


    expected_structure = "- main.py\n- src/config.py\n- src/services/user_service.py"
    assert structure == expected_structure

def test_get_file_structure_from_paths_empty_list():
    paths = []


    structure = git_utils.get_file_structure_from_paths(paths)

    assert structure == "No files in context."

def test_get_file_structure(test_repo):

    repo_path, _, _ = test_repo

    structure = git_utils.get_file_structure(str(repo_path), [], [])

    assert "test_repo/" in structure
    assert "src/" in structure
    assert "    config.py" in structure 
    assert "        user_service.py" in structure
    assert "    main.py" in structure
    assert "app_config.py" not in structure