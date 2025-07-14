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


def get_pr_diff(allowed_extensions: Optional[List[str]] = None) -> Dict[str, str]:
    if allowed_extensions is None:
        extensions_to_check = tuple(DEFAULT_EXTENSIONS)
    else:
        extensions_to_check = tuple(allowed_extensions)
        
    repo = git.Repo('.', search_parent_directories=True)
    
    base_branch = os.environ.get('GITHUB_BASE_REF', 'main')
    print(f"Info: Comparing HEAD against base branch: {base_branch}")

    try:
        repo.git.fetch('origin', base_branch)
        base_commit = repo.commit(f'origin/{base_branch}')
        diffs = repo.head.commit.diff(base_commit)
    except Exception as e:
        print(f"Error calculating diff against '{base_branch}': {e}")
        return {}

    changed_files = {}
    for diff in diffs:
        file_path = diff.a_path or diff.b_path
        if file_path.endswith(extensions_to_check):
            try:
                diff_content = diff.diff.decode('utf-8') if diff.diff else ""
                changed_files[file_path] = diff_content
            except (UnicodeDecodeError, AttributeError):
                print(f"Warning: Could not decode diff for {file_path}. Skipping.")
    
    return changed_files


def get_staged_diff(allowed_extensions: Optional[List[str]] = None) -> Dict[str, str]:

    if allowed_extensions is None:
        extensions_to_check = tuple(DEFAULT_EXTENSIONS)
    else:
        extensions_to_check = tuple(allowed_extensions)

    try:
        repo = git.Repo('.', search_parent_directories=True)
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