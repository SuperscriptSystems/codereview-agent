import os
import io
import re
import git
from unidiff import PatchSet
import logging
from typing import List, Dict

from tree_sitter import Language, Parser
from tree_sitter_languages import get_language

logger = logging.getLogger(__name__)

LANGUAGES = {
    '.cs': get_language('c_sharp'),
    '.py': get_language('python'),
    '.ts': get_language('typescript'),
    '.tsx': get_language('tsx'),
    '.js': get_language('javascript'),
}

def _query_tree(language, tree, query_string):
    query = language.query(query_string)
    captures = query.captures(tree.root_node)
    return list(set(node.text.decode('utf8') for node, _ in captures))

def extract_dependencies_from_content(file_path: str, file_content: str) -> List[str]:
    """
    Extracts dependencies using Tree-sitter for universal language analysis.
    """
    file_extension = os.path.splitext(file_path)
    
    if file_extension not in LANGUAGES:
        return []

    language = LANGUAGES[file_extension]
    parser = Parser()
    parser.set_language(language)
    
    tree = parser.parse(bytes(file_content, "utf8"))

    queries = {
        '.cs': """
            (using_directive (name_colon_qualified_name) @import) ; for C# usings
            (class_declaration base_list: (base_list (simple_base_type) @base)) ; for inheritance
        """,
        '.py': """
            (import_statement name: (dotted_name) @import)
            (from_import_statement module_name: (dotted_name) @import)
        """,
        '.ts': "(import_statement source: (string) @import)",
        '.tsx': "(import_statement source: (string) @import)",
        '.js': "(import_statement source: (string) @import)",
    }

    query_string = queries.get(file_extension, "")
    if not query_string:
        return []

    raw_imports = _query_tree(language, tree, query_string)
    

    dependencies = set()
    for imp in raw_imports:
        clean_dep = imp.strip("'\"").strip()

        final_part = os.path.basename(clean_dep)

        final_part = final_part.split('.')[-1]

        final_part = final_part.split(',')[0].strip()
        
        dependencies.add(final_part)
        
    return list(dependencies)

def get_diff(repo_path: str, base_ref: str, head_ref: str) -> str:
    """Calculates the diff between two refs using the merge base strategy."""
    try:
        repo = git.Repo(repo_path, search_parent_directories=True)
        base_commit = repo.commit(base_ref)
        head_commit = repo.commit(head_ref)
        
        merge_base = repo.merge_base(base_commit, head_commit)
        if not merge_base:
            logger.warning(f"Could not find a merge base between {base_ref} and {head_ref}. Diffing directly.")
            return repo.git.diff(base_commit, head_commit)
            
        return repo.git.diff(merge_base[0], head_commit)
    except git.GitCommandError as e:
        logger.error(f"A Git command failed while getting diff: {e}", exc_info=True)
        raise

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
            logger.warning(f"Could not process staged file {file_path}: {e}")
            
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
    if 'null' in file_path:
        return ""
    full_path = os.path.join(repo_path, file_path)
    try:
        with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()
    except FileNotFoundError:
        logger.warning(f"File not found when trying to get content: {full_path}")
        return f"File not found: {full_path}"
    except Exception as e:
        logger.error(f"Could not read file {full_path}: {e}", exc_info=True)
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
    
    logger.debug(f"Generated file structure with {len(structure)} lines.")

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
    logger.debug(f"Searching for names {names_to_find}, found {len(found_files)} files.")

    return found_files

def get_file_structure_from_paths(paths: List[str]) -> str:
    if not paths:
        return "No files in context."

    structure = []
    for path in sorted(list(set(paths))):
        normalized_path = path.replace('\\', '/')

        structure.append(f"- {normalized_path}")
    return "\n".join(structure)


def cleanup_code_context(file_path: str, content: str, diff_content: str) -> str:
    """
    Cleans up the file content to keep only relevant parts for the LLM.
    For C#, it removes bodies of methods that are neither changed nor used in changed methods.
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext != '.cs':
        return content

    try:
        language = LANGUAGES.get('.cs')
        if not language:
            return content
        
        parser = Parser()
        parser.set_language(language)
        tree = parser.parse(bytes(content, "utf8"))
        
        # 1. Identity changed lines
        changed_lines = set()
        if diff_content:
            patch = PatchSet(io.StringIO(diff_content))
            for pf in patch:
                for hunk in pf:
                    for line in hunk:
                        if line.is_added or line.is_removed:
                            if line.target_line_no: changed_lines.add(line.target_line_no)
                            if line.source_line_no: changed_lines.add(line.source_line_no)

        # 2. Find all methods
        query_methods = language.query("(method_declaration) @method")
        method_nodes = query_methods.captures(tree.root_node)
        
        methods = []
        changed_methods = []
        
        for node, _ in method_nodes:
            start_line = node.start_point[0] + 1
            end_line = node.end_point[0] + 1
            
            method_info = {
                'node': node,
                'start_line': start_line,
                'end_line': end_line,
                'name': '',
                'body_node': None
            }
            
            # Find name and body
            for child in node.children:
                if child.type == 'identifier':
                    method_info['name'] = content[child.start_byte:child.end_byte]
                if child.type == 'block':
                    method_info['body_node'] = child
            
            methods.append(method_info)
            
            # Check if changed
            if any(l in changed_lines for l in range(start_line, end_line + 1)):
                changed_methods.append(method_info)

        # 3. Find used methods in changed methods
        used_method_names = set()
        query_calls = language.query("""
            (invocation_expression (identifier) @name)
            (invocation_expression (member_access_expression name: (identifier) @name))
        """)
        
        for ch_method in changed_methods:
            calls = query_calls.captures(ch_method['node'])
            for call_node, _ in calls:
                used_method_names.add(content[call_node.start_byte:call_node.end_byte])

        # 4. Filter methods to keep
        lines = content.splitlines()
        to_stub = []
        for m in methods:
            if m not in changed_methods and m['name'] not in used_method_names:
                if m['body_node']:
                    to_stub.append(m)

        # 5. Apply stubs (from bottom to top to preserve offsets if we were deleting, 
        # but here we just replace lines in the same range)
        for m in sorted(to_stub, key=lambda x: x['start_line'], reverse=True):
            body = m['body_node']
            start_row, _ = body.start_point
            end_row, _ = body.end_point
            
            if end_row > start_row:
                # Keep braces but empty the middle
                indent = " " * body.start_point[1]
                lines[start_row] = lines[start_row][:body.start_point[1]+1] # Keep {
                for i in range(start_row + 1, end_row):
                    lines[i] = f"{indent}    // [cleaned up context]"
                # Keep } on the last line
                
        return "\n".join(lines)

    except Exception as e:
        logger.warning(f"Failed to cleanup context for {file_path}: {e}")
        return content

def create_annotated_file(full_content: str, diff_content: str) -> str:
    """
    Creates an annotated file content where each line is prefixed with its
    old and new line number and a change marker.
    Shows the WHOLE file content.
    """
    lines = full_content.splitlines()
    if not diff_content:
        return "\n".join([f"     {i+1:4d}   {line}" for i, line in enumerate(lines)])

    try:
        patch = PatchSet(io.StringIO(diff_content))
        
        added_lines = {} 
        removed_lines = {} 
    
        changes = {} 
        
        current_new_line = 1
        
        
        for pf in patch:
            for hunk in pf:
                for line in hunk:
                    if line.is_added:
                        changes[line.target_line_no] = (line.source_line_no or '', line.target_line_no, '+', line.value.rstrip())
                    elif line.is_removed:
                        # removed lines are attached to the position BEFORE the next new line
                        pos = line.target_line_no if line.target_line_no else hunk.target_start
                        if pos not in changes:
                            changes[pos] = []
                        if isinstance(changes[pos], tuple):
                            # Already has an added/unchanged line at this pos? 
                            # We need to handle multiples. Let's make it always a list.
                            changes[pos] = [changes[pos]]
                        elif not isinstance(changes[pos], list):
                            changes[pos] = []
                            
                        changes[pos].append((line.source_line_no, '', '-', line.value.rstrip()))
                    else:
                        changes[line.target_line_no] = (line.source_line_no, line.target_line_no, ' ', line.value.rstrip())

        annotated_lines = []

        # RE-SIMPLIFIED STRATEGY for Full File Annotation:
        # Use simple prefix for all lines, and if line is in diff hunks as + or -, show it.
        
        # 1. Get all line info from patch
        diff_info = {} # new_lineno -> (marker, old_lineno)
        removals = {} # new_lineno -> list of (old_lineno, text)
        
        for pf in patch:
            for hunk in pf:
                for line in hunk:
                    if line.is_added:
                        diff_info[line.target_line_no] = ('+', line.source_line_no)
                    elif line.is_removed:
                        # Removals don't have a new_lineno. We group them by context.
                        # Usually they appear before line.target_line_no
                        key = line.target_line_no if line.target_line_no else hunk.target_start
                        if key not in removals: removals[key] = []
                        removals[key].append((line.source_line_no, line.value.rstrip()))
                    else:
                        diff_info[line.target_line_no] = (' ', line.source_line_no)

        for i, line_text in enumerate(lines):
            lineno = i + 1
            
            # Show removals before this line
            if lineno in removals:
                for old_no, text in removals[lineno]:
                    annotated_lines.append(f"{old_no:>4}      - {text}")
            
            marker, old_no = diff_info.get(lineno, (' ', lineno)) # default to unchanged if not in hunk
            old_no_str = str(old_no) if old_no else ''
            annotated_lines.append(f"{old_no_str:>4} {lineno:>4} {marker} {line_text}")

        return "\n".join(annotated_lines)

    except Exception as e:
        logger.error(f"Error creating annotated file: {e}", exc_info=True)
        return f"--- FULL FILE CONTENT ---\n{full_content}\n\n--- GIT DIFF ---\n{diff_content}"


def get_structured_diff_summary(repo_path: str, base_ref: str, head_ref: str) -> dict:
    """Analyzes the diff and returns a structured summary using `git diff --numstat`."""
    summary = { "files_changed": [] }
    try:
        repo = git.Repo(repo_path, search_parent_directories=True)
        diff_output = repo.git.diff(base_ref, head_ref, '--numstat')
        for line in diff_output.splitlines():
            parts = line.split('\t')
            if len(parts) == 3:
                insertions, deletions, path = parts
                summary["files_changed"].append({
                    "path": path,
                    "insertions": int(insertions),
                    "deletions": int(deletions)
                })
        return summary
    except Exception as e:
        logger.error(f"Could not get structured diff summary: {e}", exc_info=True)
        return {"error": "Could not generate summary."}