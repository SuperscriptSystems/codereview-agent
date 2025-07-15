import os
import yaml
from dotenv import load_dotenv
from src.code_review_agent.git_utils import (
    get_pr_diff, get_staged_diff, get_pr_commit_messages, get_file_structure
)
from src.code_review_agent.reviewer import review_code_changes
from src.code_review_agent.github_client import post_review_comment, post_summary_comment
from src.code_review_agent.context_builder import find_required_context_files
from src.code_review_agent.models import CodeIssue

DEFAULT_CONFIG = {
    'supported_extensions': [
        '.py', '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss',
        '.yaml', '.yml', '.json', '.toml', '.cs', '.csproj', '.sln',
        '.vb', '.fs', '.md', '.sh', 'Dockerfile'
    ]
}

MAX_ITERATIONS = 3
MAX_CONTEXT_SIZE_TOKENS = 100000 

def count_tokens(text: str) -> int:
    return len(text) // 4

def load_config() -> dict:
    try:
        with open('.codereview.yml', 'r', encoding='utf-8') as f:
            print("Info: Loading configuration from .codereview.yml")
            config = yaml.safe_load(f)
            if isinstance(config, dict) and 'supported_extensions' in config:
                return config
            else:
                print("Warning: .codereview.yml is malformed. Using default configuration.")
                return DEFAULT_CONFIG
    except FileNotFoundError:
        print("Info: .codereview.yml not found. Using default configuration.")
        return DEFAULT_CONFIG
    except Exception as e:
        print(f"Warning: Could not load or parse .codereview.yml: {e}. Using default configuration.")
        return DEFAULT_CONFIG

def generate_dry_run_report(all_issues, files_with_issues):
    report = "# 🤖 Code Review Report (Dry Run)\n\n"
    
    if not all_issues:
        report += "🎉 **Great job! No issues were found during the review.**\n"
    else:
        report += f"Found **{len(all_issues)}** total issue(s).\n\n"
        for file_path, issues in files_with_issues.items():
            report += f"### File: `{file_path}`\n\n"
            for issue in issues:
                report += f"- **L{issue.line_number} [{issue.issue_type}]**: {issue.comment}\n"
                if issue.suggestion:
                    report += f"  ```suggestion\n  {issue.suggestion}\n  ```\n"
            report += "\n---\n"
        
    with open("review_report.md", "w", encoding="utf-8") as f:
        f.write(report)
    print("✅ Generated dry run report: review_report.md")

def run_agent():
    
    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY not found in .env file or environment variables.")

    config = load_config()
    supported_extensions = config.get('supported_extensions', DEFAULT_CONFIG['supported_extensions'])
    target_path = os.environ.get('TARGET_REPO_PATH', '.')
    is_pr_mode = os.environ.get('GITHUB_ACTIONS') == 'true'
    is_dry_run = os.environ.get('DRY_RUN', 'false').lower() == 'true'

    if is_dry_run:
        print("🧪 Starting Code Review Agent in DRY RUN mode...")
    elif is_pr_mode:
        print("🚀 Starting Code Review Agent in PR mode...")
    else:
        print("💻 Starting Code Review Agent in local staged mode...")

    # Phase 1: Context Building
    changed_files_map = get_pr_diff(target_path, allowed_extensions=supported_extensions) if is_pr_mode else get_staged_diff(target_path, allowed_extensions=supported_extensions)

    commit_messages = get_pr_commit_messages(target_path) if is_pr_mode else "Local changes"
    file_structure = get_file_structure(root_dir=target_path)
    
    final_context_files = list(changed_files_map.keys())
    current_tokens = 0

    for i in range(MAX_ITERATIONS):
        print(f"\n--- Context Building Iteration {i + 1}/{MAX_ITERATIONS} ---")
        
        context_requirements = find_required_context_files(
            changed_files_map=changed_files_map,
            commit_messages=commit_messages,
            full_file_structure=file_structure,
            current_context_files=final_context_files
        )

        if context_requirements.is_sufficient or not context_requirements.required_additional_files:
            print("✅ Context is now sufficient.")
            break

        new_files_to_add = [
            f for f in context_requirements.required_additional_files if f not in final_context_files
        ]

        if not new_files_to_add:
            print("✅ Agent requested existing files. Context is considered sufficient.")
            break
            
        print(f"➕ Adding {len(new_files_to_add)} new files to context: {new_files_to_add}")
        final_context_files.extend(new_files_to_add)

        current_content_for_token_check = ""
        for file_path in final_context_files:
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    current_content_for_token_check += f.read()
            except FileNotFoundError:
                pass
        
        current_tokens = count_tokens(current_content_for_token_check)
        if current_tokens > MAX_CONTEXT_SIZE_TOKENS:
            print(f"⚠️ Warning: Context size ({current_tokens} tokens) exceeds limit. Stopping context building.")
            break
    else:
        print(f"⚠️ Warning: Reached max iterations ({MAX_ITERATIONS}). Proceeding with current context.")

    print(f"\nFinal context includes {len(final_context_files)} files: {final_context_files}")

    # Phase 2: Code Review
    all_issues: list[CodeIssue] = []
    files_with_issues = {}

    context_content_full = ""
    for context_file_path in final_context_files:
        try:
            with open(context_file_path, 'r', encoding='utf-8') as f:
                context_content_full += f"--- START OF FILE: {context_file_path} ---\n"
                context_content_full += f.read()
                context_content_full += f"\n--- END OF FILE: {context_file_path} ---\n\n"
        except FileNotFoundError:
             context_content_full += f"--- FILE NOT FOUND: {context_file_path} ---\n\n"

    for file_path, diff in changed_files_map.items():
        review_result = review_code_changes(file_path, diff, context_content_full)

        if not review_result.is_ok():
            all_issues.extend(review_result.issues)
            files_with_issues[file_path] = review_result.issues
    


    print(f"🏁 Review complete. Found {len(all_issues)} issue(s) in total.")

    if is_dry_run:
        generate_dry_run_report(all_issues, files_with_issues)
    elif is_pr_mode and all_issues:
        for file_path, issues in files_with_issues.items():
            for issue in issues:
                post_review_comment(issue, file_path)
        post_summary_comment(all_issues)
    elif not is_pr_mode and all_issues:
        for file_path, issues in files_with_issues.items():
            print(f"\n🚨 Issues in `{file_path}`:")
            for issue in issues:
                 print(f"  - L{issue.line_number} [{issue.issue_type}]: {issue.comment}")
                 if issue.suggestion:
                     print(f"    💡 Suggestion: {issue.suggestion}")    
    else: # Local mode
        for file_path, issues in files_with_issues.items():
            print(f"\n🚨 Issues in `{file_path}`:")
            for issue in issues:
                 print(f"  - L{issue.line_number} [{issue.issue_type}]: {issue.comment}")
                 if issue.suggestion:
                     print(f"    💡 Suggestion: {issue.suggestion}")
        # Reporting
    if not all_issues:
        print("🎉 Great job! No issues found.")
        return
    
if __name__ == "__main__":
    run_agent()