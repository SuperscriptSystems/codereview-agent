import os
import git
from typing import Dict, List, Optional
from github import Github
from .models import CodeIssue

DEFAULT_EXTENSIONS = [
    '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss',
    '.yaml', '.yml', '.json', '.toml', '.md', '.sh', '.Dockerfile',
    '.cs', '.csproj', '.sln', '.vb', '.fs'
]


def get_pr_commit_messages(repo_path: str) -> str:
    """Fetches all commit messages from the current Pull Request."""
    try:
        repo = git.Repo(repo_path, search_parent_directories=True)

        messages = [commit.message.strip() for commit in repo.iter_commits('HEAD', max_count=5)]
        return "\n---\n".join(messages)
    except Exception as e:
        print(f"Warning: Could not get commit messages: {e}")
        return "Could not retrieve commit messages."

def get_file_structure(root_dir='.', ignored_paths=None, ignored_extensions=None) -> str:

    if ignored_paths is None:
        ignored_paths = {'node_modules', 'venv', '.git', '__pycache__', 'dist', 'build'}
    if ignored_extensions is None:
        ignored_extensions = {'.dll', '.so', '.png', '.jpg', '.jpeg', '.gif', '.min.js', '.lock'}

    structure = []
    for root, dirs, files in os.walk(root_dir):
        # Виключаємо ігноровані директорії
        dirs[:] = [d for d in dirs if d not in ignored_paths]
        
        level = root.replace(root_dir, '').count(os.sep)
        indent = ' ' * 4 * level
        structure.append(f"{indent}{os.path.basename(root)}/")
        
        sub_indent = ' ' * 4 * (level + 1)
        for f in files:
            if not any(f.endswith(ext) for ext in ignored_extensions):
                structure.append(f"{sub_indent}{f}")
                
    return "\n".join(structure)

def post_pr_comment(issue: CodeIssue, file_path: str):
    try:
        token = os.environ['GITHUB_TOKEN']
        pr_number = int(os.environ['GITHUB_PR_NUMBER'])
        repo_name = os.environ['GITHUB_REPOSITORY'] 
        
        g = Github(token)
        repo = g.get_repo(repo_name)
        pr = repo.get_pull(pr_number)
        
        commit = pr.get_commits().reversed[0]

        pr.create_review_comment(
            body=f"**[{issue.issue_type}]** {issue.comment}",
            commit=commit.sha,
            path=file_path,
            line=issue.line_number
        )
        print(f"✅ Successfully posted a comment to {file_path} at line {issue.line_number}.")
    except Exception as e:
        print(f"❌ Failed to post comment to GitHub: {e}")


def get_pr_diff(repo_path: str, allowed_extensions: Optional[List[str]] = None) -> Dict[str, str]:
    """
    Calculates the diff for a Pull Request using the correct "merge base" strategy.
    """
    if allowed_extensions is None:
        extensions_to_check = tuple(DEFAULT_EXTENSIONS)
    else:
        extensions_to_check = tuple(allowed_extensions)
            
    repo = git.Repo(repo_path, search_parent_directories=True)
    
    try:
        base_ref = os.environ.get('GITHUB_BASE_REF')
        if not base_ref:
            remote_info = repo.git.remote('show', 'origin')
            for line in remote_info.split('\n'):
                if 'HEAD branch' in line:
                    base_ref = line.split(':')[1].strip()
                    break
        if not base_ref:
            base_ref = 'main'

        print(f"Info: Base branch determined as: '{base_ref}'")

        head_commit = repo.head.commit
        repo.git.fetch('origin', base_ref)
        base_commit = repo.commit(f'origin/{base_ref}')
        
        merge_base = repo.merge_base(head_commit, base_commit)
        
        if not merge_base:
             print("Warning: Could not find a merge base. Diffing against base branch directly.")
             diffs = repo.head.commit.diff(base_commit)
        else:
             diffs = head_commit.diff(merge_base[0])

    except git.GitCommandError as e:
        print(f"Error calculating diff against 'origin/{base_ref}': {e}.")
        return {}
    except Exception as e:
        print(f"An unexpected error occurred during diff calculation: {e}")
        return {}

    changed_files = {}
    for diff in diffs:
        file_path = diff.a_path or diff.b_path
        if file_path and file_path.endswith(extensions_to_check):
            try:

                diff_content = diff.diff.decode('utf-8', errors='ignore') if diff.diff else ""
                changed_files[file_path] = diff_content
            except Exception:
                print(f"Warning: Could not get diff content for {file_path}. Skipping.")
        
    return changed_files

def get_staged_diff(repo_path: str, allowed_extensions: Optional[List[str]] = None) -> Dict[str, str]:

    if allowed_extensions is None:
        extensions_to_check = tuple(DEFAULT_EXTENSIONS)
    else:
        extensions_to_check = tuple(allowed_extensions)

    try:
        repo = git.Repo(repo_path, search_parent_directories=True)
    except git.InvalidGitRepositoryError:
        print("Error: This is not a Git repository. Please run 'git init'.")
        return {}


    try:

        head_commit = repo.head.commit
        diff_index = repo.index.diff(head_commit)
    except ValueError:

        print("Info: No HEAD commit found. Assuming this is the initial commit.")
        diff_index = repo.index.diff(None)

    staged_files = {}

    def process_diff_item(diff_item, is_new_file=False):
        file_path = diff_item.a_path
        if file_path.endswith(extensions_to_check):
            try:
                diff_content = diff_item.diff.decode('utf-8') if diff_item.diff else diff_item.b_blob.data_stream.read().decode('utf-8')
                staged_files[file_path] = diff_content
            except UnicodeDecodeError:
                print(f"Warning: Skipping binary file or file with non-utf8 encoding: {file_path}")
            except AttributeError:

                staged_files[file_path] = ""

    for diff in diff_index:
        process_diff_item(diff)


    for untracked_file in repo.untracked_files:
         if untracked_file in repo.index.entries:
            if untracked_file.endswith(extensions_to_check):
                 try:
                    with open(untracked_file, 'r', encoding='utf-8') as f:
                        staged_files[untracked_file] = f.read()
                 except UnicodeDecodeError:
                    print(f"Warning: Skipping binary file or file with non-utf8 encoding: {untracked_file}")


    return staged_files