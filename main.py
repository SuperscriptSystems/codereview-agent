import os
import git
from typing import List, Dict

def get_diff(repo_path: str, base_ref: str, head_ref: str) -> str:
    """
    Calculates the diff between two refs using the merge base strategy.
    This is the main function for getting diff for a commit range or a branch.
    """
    repo = git.Repo(repo_path)
    base_commit = repo.commit(base_ref)
    head_commit = repo.commit(head_ref)
    
    merge_base = repo.merge_base(base_commit, head_commit)
    if not merge_base:
        return repo.git.diff(base_commit, head_commit)
        
    return repo.git.diff(merge_base[0], head_commit)

def get_staged_diff_content(repo_path: str) -> Dict[str, str]:
    """
    Gets the content of all staged files for local review before commit.
    """
    repo = git.Repo(repo_path)
    staged_content = {}
    
    diff_index = repo.index.diff(None)
    for diff_item in diff_index:
        if diff_item.change_type in ('A', 'M'):
            file_path = diff_item.a_path
            try:
                content = diff_item.b_blob.data_stream.read().decode('utf-8', errors='ignore')
                staged_content[file_path] = content
            except Exception as e:
                print(f"Warning: Could not read staged file {file_path}: {e}")
                
    return staged_content

def get_commit_messages(repo_path: str, base_ref: str, head_ref: str) -> str:
    repo = git.Repo(repo_path)
    try:
        commits = list(repo.iter_commits(f'{base_ref}..{head_ref}'))
        return "\n---\n".join([c.message.strip() for c in commits])
    except git.GitCommandError:
        return f"Could not find commits between {base_ref} and {head_ref}"

def get_changed_files_from_diff(diff_text: str) -> List[str]:
    """Parses a diff text to extract the list of changed file paths."""
    changed_files = []
    for line in diff_text.splitlines():
        if line.startswith('+++ b/'):
            changed_files.append(line[6:])
    return changed_files

def get_file_content(repo_path: str, file_path: str) -> str:
    full_path = os.path.join(repo_path, file_path)
    try:
        with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    except FileNotFoundError:
        return f"File not found: {full_path}"
    except Exception as e:
        return f"Could not read file {full_path}: {e}"

def get_file_structure(root_dir: str, ignored_paths: List[str], ignored_extensions: List[str]) -> str:
    structure = []
    for root, dirs, files in os.walk(root_dir, topdown=True):
        dirs[:] = [d for d in dirs if d not in ignored_paths and not d.startswith('.')]
        level = os.path.relpath(root, root_dir).count(os.sep)
        
        indent = ' ' * 4 * level
        structure.append(f"{indent}{os.path.basename(root)}/")
        
        sub_indent = ' ' * 4 * (level + 1)
        for f in files:
            if not any(f.endswith(ext) for ext in ignored_extensions) and not f.startswith('.'):
                structure.append(f"{sub_indent}{f}")
                
    return "\n".join(structure)