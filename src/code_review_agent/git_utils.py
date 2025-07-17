import os
import git
from typing import List, Dict

def get_diff(repo_path: str, base_ref: str, head_ref: str) -> str:
    """Calculates the diff between two refs using the merge base strategy."""
    repo = git.Repo(repo_path, search_parent_directories=True)
    base_commit = repo.commit(base_ref)
    head_commit = repo.commit(head_ref)
    
    merge_base = repo.merge_base(base_commit, head_commit)
    if not merge_base:
        return repo.git.diff(base_commit, head_commit)
        
    return repo.git.diff(merge_base[0], head_commit)

def get_staged_diff_content(repo_path: str) -> Dict[str, str]:
    """Gets the content and diff for all staged files."""
    repo = git.Repo(repo_path, search_parent_directories=True)
    staged_files = {}
    
    try:
        diff_index = repo.index.diff('HEAD')
    except git.BadName:
        diff_index = repo.index.diff(None)

    for diff_item in diff_index:
        file_path = diff_item.a_path
        try:
            diff_text = diff_item.diff.decode('utf-8', errors='ignore') if diff_item.diff else ''
          
            content = diff_item.b_blob.data_stream.read().decode('utf-8', errors='ignore')
            staged_files[file_path] = {'diff': diff_text, 'content': content}
        except Exception as e:
            print(f"Warning: Could not process staged file {file_path}: {e}")
            
    return staged_files

def get_commit_messages(repo_path: str, base_ref: str, head_ref: str) -> str:
    """Gets commit messages from a commit range."""
    repo = git.Repo(repo_path, search_parent_directories=True)
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
    """Gets the full content of a specific file."""
    full_path = os.path.join(repo_path, file_path)
    try:
        with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    except FileNotFoundError:
        return f"File not found: {full_path}"
    except Exception as e:
        return f"Could not read file {full_path}: {e}"

def get_file_structure(root_dir: str, ignored_paths: List[str], ignored_extensions: List[str]) -> str:
    """Generates a string representation of the file structure."""
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


def find_files_by_names(
    root_dir: str, 
    names_to_find: List[str],
    ignored_paths: List[str],
    ignored_extensions: List[str]
) -> List[str]:
    """Recursively searches a directory, ignoring specified paths and extensions."""
    found_files = []
    names_set = set(names_to_find)
    
    if not names_set:
        return []

    for root, dirs, files in os.walk(root_dir, topdown=True):
        dirs[:] = [d for d in dirs if d not in ignored_paths and not d.startswith('.')]

        for file in files:
            if any(file.endswith(ext) for ext in ignored_extensions):
                continue

            if any(name_part in file for name_part in names_set):
                full_path = os.path.join(root, file)
                relative_path = os.path.relpath(full_path, root_dir)
                found_files.append(relative_path.replace('\\', '/'))

    return found_files

def get_file_structure_from_paths(paths: List[str]) -> str:
    if not paths:
        return "No files in context."

    structure = []
    for path in sorted(list(set(paths))):
        normalized_path = path.replace('\\', '/')

        structure.append(f"- {normalized_path}")
        
    return "\n".join(structure)