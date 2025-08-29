import os
import pytest
from git import Repo
from code_review_agent import git_utils

@pytest.fixture
def test_repo(tmp_path):
    repo_path = tmp_path / "test_repo"
    repo_path.mkdir()
    
    (repo_path / "src").mkdir()
    (repo_path / "src" / "interfaces").mkdir()
    (repo_path / "src" / "services").mkdir()
    (repo_path / "src" / "interfaces" / "IUserService.cs").write_text("public interface IUserService {}")
    (repo_path / "src" / "services" / "UserService.cs").write_text(
        "using Company.Core.Interfaces;\n\npublic class UserService : IUserService {}"
    )
    
    repo = Repo.init(repo_path)
    repo.index.add(["src/interfaces/IUserService.cs", "src/services/UserService.cs"])
    repo.index.commit("Initial commit")
    base_commit = repo.head.commit
    
    (repo_path / "src" / "services" / "UserService.cs").write_text(
        "using Company.Core.Interfaces;\n\n// A change\npublic class UserService : IUserService {}"
    )
    repo.index.add(["src/services/UserService.cs"])
    repo.index.commit("Second commit")
    head_commit = repo.head.commit
    
    return str(repo_path), base_commit.hexsha, head_commit.hexsha


def test_get_diff(test_repo):
    repo_path, base_ref, head_ref = test_repo
    diff = git_utils.get_diff(repo_path, base_ref, head_ref)
    assert '+++ b/src/services/UserService.cs' in diff
    assert "+// A change" in diff

def test_get_commit_messages(test_repo):
    repo_path, base_ref, head_ref = test_repo
    messages = git_utils.get_commit_messages(repo_path, base_ref, head_ref)
    assert "Second commit" in messages


def test_extract_dependencies_from_content_csharp():
    """Tests Tree-sitter dependency extraction for C#."""
    file_path = "MyService.cs"
    file_content = """
    using System.Text;
    using Company.Core.Models;

    namespace MyNamespace
    {
        public class MyService : IMyService, IDisposable
        {
            // ...
        }
    }
    """
    dependencies = git_utils.extract_dependencies_from_content(file_path, file_content)

    assert set(dependencies) == {"Text", "Models", "IMyService", "IDisposable"}

def test_extract_dependencies_from_content_python():
    """Tests Tree-sitter dependency extraction for Python."""
    file_path = "main.py"
    file_content = """
    import os
    from my_project.utils import helper_function
    """
    dependencies = git_utils.extract_dependencies_from_content(file_path, file_content)
    assert set(dependencies) == {"os", "utils"}



def test_find_files_by_names(test_repo):
    repo_path, _, _ = test_repo
    names_to_find = ["IUserService", "UserService"]
    found_files = git_utils.find_files_by_names(repo_path, names_to_find, [], [])
    
    assert len(found_files) == 2
    assert os.path.join('src', 'interfaces', 'IUserService.cs').replace('\\', '/') in found_files
    assert os.path.join('src', 'services', 'UserService.cs').replace('\\', '/') in found_files

def test_create_annotated_file():
    """
    Tests that the annotation function correctly merges a diff and full content.
    """

    full_content = "line 1\nline two updated\nline 3"
    diff_content = (
        "--- a/file.txt\n"
        "+++ b/file.txt\n"
        "@@ -1,3 +1,3 @@\n"
        " line 1\n"
        "-line 2\n"
        "+line two updated\n"
        " line 3\n"
    )
    
    annotated_file = git_utils.create_annotated_file(full_content, diff_content)
    
    expected_output = """   1    1  line 1
   2      -line 2
        2 +line two updated
   3    3  line 3"""
    
    assert annotated_file.strip() == expected_output.strip()