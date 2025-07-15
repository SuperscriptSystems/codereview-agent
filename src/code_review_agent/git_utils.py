import os
import git
from typing import List, Dict

def get_diff(repo_path: str, base_ref: str, head_ref: str) -> str:
    repo = git.Repo(repo_path)
    base_commit = repo.commit(base_ref)
    head_commit = repo.commit(head_ref)

    merge_base = repo.merge_base(base_commit, head_commit)
    if not merge_base:
        raise ValueError("Could not find a common merge base.")

    return repo.git.diff(merge_base[0], head_commit)

def get_commit_messages(repo_path: str, base_ref: str, head_ref: str) -> str:
    repo = git.Repo(repo_path)
    commits = list(repo.iter_commits(f'{base_ref}..{head_ref}'))
    return "\n---\n".join([c.message.strip() for c in commits])

def get_changed_files_content(repo_path: str, diff_text: str) -> Dict[str, str]:
    changed_files = {}
    for line in diff_text.splitlines():
        if line.startswith('+++ b/'):
            file_path = line[6:]
            try:
                with open(os.path.join(repo_path, file_path), 'r', encoding='utf-8') as f:
                    changed_files[file_path] = f.read()
            except (FileNotFoundError, UnicodeDecodeError):
                changed_files[file_path] = f"Could not read file: {file_path}"
    return changed_files

def get_file_structure(root_dir: str, ignored_paths: List[str], ignored_extensions: List[str]) -> str:
    structure = []
    for root, dirs, files in os.walk(root_dir, topdown=True):
        dirs[:] = [d for d in dirs if d not in ignored_paths and not d.startswith('.')]
        level = root.replace(root_dir, '').count(os.sep)
        indent = ' ' * 4 * level
        structure.append(f"{indent}{os.path.basename(root)}/")
        
        sub_indent = ' ' * 4 * (level + 1)
        for f in files:
            if not any(f.endswith(ext) for ext in ignored_extensions) and not f.startswith('.'):
                structure.append(f"{sub_indent}{f}")
    return "\n".join(structure)


def get_file_content(repo_path: str, file_path: str) -> str:
    try:
        with open(os.path.join(repo_path, file_path), 'r', encoding='utf-8') as f:
            return f.read()
    except (FileNotFoundError, UnicodeDecodeError):
        return f"Could not read file: {file_path}"
