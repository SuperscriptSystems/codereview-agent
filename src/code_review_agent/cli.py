import os
import yaml
import typer
import logging
from typing import List, Optional, Dict
from typing_extensions import Annotated
from dotenv import load_dotenv
from unidiff import PatchSet
import io

from . import bitbucket_client, github_client
from . import git_utils, context_builder, reviewer
from .models import IssueType, CodeIssue



app = typer.Typer(add_completion=False)


def setup_logging(trace_mode: bool):
    """Configures logging for the application."""
    log_level = logging.DEBUG if trace_mode else logging.INFO
    
    log_format = '%(asctime)s - %(levelname)s - [%(name)s] - %(message)s' if trace_mode else '%(message)s'
    
    logging.basicConfig(
        level=log_level,
        format=log_format,
        datefmt='%Y-%m-%d %H:%M:%S',
        force=True
    )
    
    if trace_mode:
        logging.info("🕵️ Trace mode enabled. Logging will be verbose.")



def load_config(repo_path: str) -> dict:
    config_path = os.path.join(repo_path, '.codereview.yml')
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        typer.secho("Info: .codereview.yml not found. Using defaults.", fg=typer.colors.BLUE)
        return {
            'filtering': {'ignored_extensions': ['.dll', '.so', '.exe', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.min.js', '.lock', '.zip', '.o', '.a', '.obj', '.lib', '.pdb'], 
            'ignored_paths': [ 'node_modules', 'venv', '.venv', 'dist', 'build', 'target', '.gitignore', '.git', '__pycache__', 'dist', 'build', 'target', '.next', '.pytest_cache']},
            'review_rules': [],
            'llm': {}
        }
    except Exception as e:
        logging.info(f"Warning: Could not load or parse .codereview.yml: {e}. Using defaults.")
        return {}


POSSIBLE_FOCUS_AREAS = list(IssueType.__args__) 


@app.command()
def review(
    repo_path: Annotated[str, typer.Option("--repo-path", help="Path to the local Git repository.")] = ".",
    base_ref: Annotated[str, typer.Option(help="The base commit/ref to compare against.")] = "HEAD~1",
    head_ref: Annotated[str, typer.Option(help="The commit hash or ref to review.")] = "HEAD",
    staged: Annotated[bool, typer.Option(help="Review only staged files instead of a commit range.")] = False,
    focus_from_cli: Annotated[Optional[List[str]], typer.Option(
        "-f", "--focus", 
        help=f"Areas of focus. Can be used multiple times. Possible values: {', '.join(POSSIBLE_FOCUS_AREAS)}"
    )] = None,
    trace: Annotated[bool, typer.Option(
        "--trace", help="Enable detailed debug logging to the console."
    )] = False,
):
    """
    Performs an AI-powered, context-aware code review using an iterative context-building approach.
    """

    setup_logging(trace_mode=trace)

    load_dotenv(override=True)

    if not os.getenv("LLM_API_KEY"):
        logging.error("LLM_API_KEY is not set.")
        raise typer.Exit(code=1)

    config = load_config(repo_path)
    # enough 3 iteration to ensure 95% results and prevent cyclicality for all LLMs
    max_iterations = config.get('max_context_iterations', 3)
    max_context_files = config.get('max_context_files', 25)
    llm_config = config.get('llm', {})
    filtering_config = config.get('filtering', {})
    
    final_focus_areas: List[str]
    if focus_from_cli:
        valid_focus_areas = []
        possible_areas_lower = {area.lower() for area in POSSIBLE_FOCUS_AREAS}

        for area in focus_from_cli:
            if area.lower() in possible_areas_lower:
                original_cased_area = next(p for p in POSSIBLE_FOCUS_AREAS if p.lower() == area.lower())
                valid_focus_areas.append(original_cased_area)
            else:
                typer.secho(f"Warning: Invalid focus area '{area}' ignored.", fg=typer.colors.YELLOW)
        
        final_focus_areas = valid_focus_areas
        logging.info("🎯 Using focus areas from command line arguments.")
        
    elif 'review_focus' in config and config['review_focus']:
        final_focus_areas = config['review_focus']
        logging.info("🎯 Using focus areas from .codereview.yml config file.")
    else:
        final_focus_areas = ["LogicError"]
        logging.info("🎯 No focus specified. Checking for 'LogicError' by default.")


    logging.info("🔍 Gathering initial data...")

    commit_messages: str
    changed_files_content: Dict[str, str] = {}
    changed_files_map: Dict[str, str] = {}
    
    if staged:
        typer.secho("Mode: Reviewing STAGED files.", bold=True)
        staged_data = git_utils.get_staged_diff_content(repo_path)
        for path, data in staged_data.items():
            changed_files_map[path] = data.get('diff', '')
            changed_files_content[path] = data.get('content', '')
        commit_messages = "Reviewing staged files before commit."
    else:
        logging.info(f"Mode: Reviewing commit range {base_ref}..{head_ref}")


        diff_text  = git_utils.get_diff(repo_path, base_ref, head_ref)
        commit_messages = git_utils.get_commit_messages(repo_path, base_ref, head_ref)

        patch = PatchSet(io.StringIO(diff_text))
        for patched_file in patch:
            file_path = patched_file.target_file[2:]
            changed_files_map[file_path] = str(patched_file)
            changed_files_content[file_path] = git_utils.get_file_content(repo_path, file_path)

    if not changed_files_content:
        logging.info("✅ No changed files detected to review.")
        raise typer.Exit()

    logging.info("🧠 Performing smart import analysis to pre-populate context...")
    
    initial_dependencies = set()
    for path, content in changed_files_content.items():
        deps = git_utils.extract_dependencies_from_content(path, content)
        if deps:
            logging.info(f"   - Found potential dependencies in `{path}`: {deps}")
            initial_dependencies.update(deps)


    final_context_content = dict(changed_files_content)

    if initial_dependencies:
        logging.info(f"🔎 Searching for files related to found dependencies: {list(initial_dependencies)}")
        
        found_dependency_files = git_utils.find_files_by_names(
            repo_path,
            list(initial_dependencies),
            ignored_paths=filtering_config.get('ignored_paths', []),
            ignored_extensions=filtering_config.get('ignored_extensions', [])
        )
        
        new_files_to_add = [f for f in found_dependency_files if f not in final_context_content]

        if new_files_to_add:
            logging.info(f"➕ Automatically adding {len(new_files_to_add)} files to initial context: {new_files_to_add}")
            for file_path in new_files_to_add:
                final_context_content[file_path] = git_utils.get_file_content(repo_path, file_path)

    full_diff_for_context = "\n".join(changed_files_map.values())

    for i in range(max_iterations):
        logging.info(f"--- Context Building Iteration {i + 1}/{max_iterations} ---")
        
        context_file_structure = git_utils.get_file_structure_from_paths(list(final_context_content.keys()))
        
        context_req = context_builder.determine_context(
            diff=full_diff_for_context,
            commit_messages=commit_messages,
            changed_files_content=changed_files_content, 
            full_context_content=final_context_content,
            file_structure=context_file_structure,
            current_context_files=list(final_context_content.keys()),
            llm_config=llm_config,
        )

        logging.info(f"🧠 Agent reasoning: {context_req.reasoning}")

        if context_req.is_sufficient or not context_req.required_additional_files:
            logging.info("✅ Context is now sufficient.")
            break

        logging.info(f"🔎 Searching for requested files: {context_req.required_additional_files}")
        newly_found_files = git_utils.find_files_by_names(
            repo_path, 
            context_req.required_additional_files,
            ignored_paths=filtering_config.get('ignored_paths', []),
            ignored_extensions=filtering_config.get('ignored_extensions', [])
        )
        
        new_files_to_add = [f for f in newly_found_files if f not in final_context_content]

        if not new_files_to_add:
            typer.secho("✅ Agent requested files, but no new files were found. Context is considered sufficient.", fg=typer.colors.GREEN)
            break
        
        typer.echo(f"➕ Adding {len(new_files_to_add)} new files to context: {new_files_to_add}")
        for file_path in new_files_to_add:
            final_context_content[file_path] = git_utils.get_file_content(repo_path, file_path)

        if len(final_context_content) > max_context_files:
            typer.secho(f"⚠️ Warning: Context file count ({len(final_context_content)}) exceeds limit of {max_context_files}.", fg=typer.colors.YELLOW)
            break
    else:
        typer.secho(f"⚠️ Warning: Reached max iterations ({max_iterations}).", fg=typer.colors.YELLOW)


    logging.info("\n--- Starting Code Review Phase ---")
    logging.info(f"🎯 Review focus: {', '.join(final_focus_areas)}")


    review_results = reviewer.run_review(
        changed_files_map=changed_files_map,
        final_context_content=final_context_content,
        review_rules=config.get('review_rules', []),
        llm_config=llm_config,
        focus_areas=final_focus_areas  
    )

    logging.info("\n\n--- 🏁 Review Complete ---")

    all_issues: List[CodeIssue] = []
    files_with_issues = {}
    for file_path, result in review_results.items():
        if not result.is_ok():
            all_issues.extend(result.issues)
            files_with_issues[file_path] = result.issues

    is_github_pr = "GITHUB_ACTIONS" in os.environ and "GITHUB_PR_NUMBER" in os.environ
    is_bitbucket_pr = "BITBUCKET_PR_ID" in os.environ
    
    if is_github_pr:
        logging.info("🚀 Publishing results to GitHub PR...")
        github_client.handle_pr_results(all_issues, files_with_issues, changed_files_map)

    elif is_bitbucket_pr:
        logging.info("🚀 Publishing results to Bitbucket PR...")
        bitbucket_client.cleanup_and_post_all_comments(all_issues, files_with_issues)
        
    elif all_issues:
        for file_path, issues in files_with_issues.items():
            logging.info(f"\n🚨 Issues in `{file_path}`:")
            for issue in issues:
                logging.info(f"  - L{issue.line_number} [{issue.issue_type}]: {issue.comment}")
                if issue.suggestion:
                    logging.info(f"    💡 Suggestion: {issue.suggestion}")
                    logging.info(f"    ```\n    {issue.suggestion}\n    ```")


    if not all_issues:
        logging.info("🎉 Great job! No issues found.")
    else:
        logging.info(f"\nFound a total of {len(all_issues)} issue(s).")

def main():
    app()

if __name__ == "__main__":
    main()