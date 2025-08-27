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
from . import jira_client
from . import relevance_assessor
from .models import IssueType, CodeIssue

def prioritize_changed_files(changed_files_map: Dict[str, str]) -> List[List[str]]:
    """
    Groups changed files into priority tiers.
    Tier 1: Interfaces, DTOs, Core business logic.
    Tier 2: Controllers, UI components.
    Tier 3: Configs, styles, docs.
    """
    tier1, tier2, tier3 = [], [], []
    for path in changed_files_map.keys():
        path_lower = path.lower()
        
        if any(k in path_lower for k in ['interface', 'dto', 'model', 'service', 'core', 'abstraction']):
            tier1.append(path)
        elif any(k in path_lower for k in ['controller', 'component', 'page']):
            tier2.append(path)
        else:
            tier3.append(path)
    return [tier1, tier2, tier3]

def _get_task_id_from_git_info(commit_messages: str) -> str | None:
    """
    Finds a Jira task ID by searching in common CI/CD environment variables and commit messages.
    Prioritizes branch names over commit messages.
    """

    branch_name = os.environ.get("GITHUB_HEAD_REF") or os.environ.get("BITBUCKET_BRANCH", "")
    if branch_name:
        task_id = jira_client.find_task_id(branch_name)
        if task_id:
            logging.info(f"Found Jira task ID '{task_id}' in branch name.")
            return task_id

    commit_text = " ".join(commit_messages)
    task_id = jira_client.find_task_id(commit_text)
    if task_id:
        logging.info(f"Found Jira task ID '{task_id}' in commit messages.")
        return task_id
    
    logging.info("No Jira task ID found in branch name or commit messages.")
    return None

def filter_test_files(
    changed_files_map: Dict[str, str], 
    test_keywords: List[str]
) -> Dict[str, str]:
    """
    Filters out test files from the map of changed files.
    """
    logging.info("🔬 Filtering out test files from the review scope...")
    
    files_for_review_map = {}
    for path, diff in changed_files_map.items():
        is_test_file = any(
            keyword in part.lower() 
            for keyword in test_keywords 
            for part in os.path.normpath(path).split(os.sep)
        )
        
        if not is_test_file:
            files_for_review_map[path] = diff
        else:
            logging.info(f"   - Ignoring test file based on keywords: {path}")
            
    return files_for_review_map

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
    
    test_keywords = filtering_config.get('test_keywords', ['test', 'spec'])
    changed_files_map = filter_test_files(changed_files_map, test_keywords)

    if not changed_files_map:
        logging.info("✅ No non-test files to review after filtering.")
        raise typer.Exit()
        
    changed_files_content = {
        path: git_utils.get_file_content(repo_path, path) 
        for path in changed_files_map.keys()
    }

    task_id = _get_task_id_from_git_info(commit_messages)

    jira_details_text = ""

    if task_id:
        task_details = jira_client.get_task_details(task_id)
        if task_details:
            jira_details_text = (
                f"**--- JIRA TASK CONTEXT ({task_id}) ---**\n"
                f"**Title:** {task_details['summary']}\n"
                f"**Description:**\n{task_details['description']}\n"
                f"**---------------------------------**\n\n"
            )
            logging.info(f"✅ Successfully fetched context from Jira task {task_id}.")

    logging.info("🧠 Performing smart dependency analysis to pre-populate context...")
    
    file_tiers = prioritize_changed_files(changed_files_map)
    
    final_context_content = dict(changed_files_content)
    
    full_project_structure = git_utils.get_file_structure(
        repo_path,
        filtering_config.get('ignored_paths', []),
        filtering_config.get('ignored_extensions', [])
    )


    for i, tier in enumerate(file_tiers):
        if not tier: continue
        logging.info(f"\n--- Building context for Priority Tier {i+1} ({len(tier)} files) ---")

        for file_path in tier:
            diff_content = changed_files_map[file_path]
            logging.info(f"   - Analyzing dependencies for: {file_path}")
            
            context_req = context_builder.determine_context(
                diff=diff_content,
                commit_messages=commit_messages,
                changed_files_content={file_path: changed_files_content[file_path]},
                jira_details=jira_details_text,
                full_context_content=final_context_content,
                file_structure=full_project_structure,
                current_context_files=list(final_context_content.keys()),
                llm_config=llm_config,
            )
            
            if context_req.is_sufficient or not context_req.required_additional_files:
                continue
            
            newly_found_files = git_utils.find_files_by_names(
                repo_path, 
                context_req.required_additional_files,
                ignored_paths=filtering_config.get('ignored_paths', []),
                ignored_extensions=filtering_config.get('ignored_extensions', [])
            )
            
            new_files_to_add = [f for f in newly_found_files if f not in final_context_content]

            if new_files_to_add:
                logging.info(f"   - Adding {len(new_files_to_add)} new files to context: {new_files_to_add}")
                for new_file in new_files_to_add:
                    final_context_content[new_file] = git_utils.get_file_content(repo_path, new_file)

                if len(final_context_content) > max_context_files:
                    logging.warning("⚠️ Max context files limit reached. Stopping context building.")
                    break
        if len(final_context_content) > max_context_files: break


    logging.info("\n--- Starting Code Review Phase ---")
    logging.info(f"🎯 Review focus: {', '.join(final_focus_areas)}")


    review_results = reviewer.run_review(
        changed_files_map=changed_files_map,
        final_context_content=final_context_content,
        jira_details=jira_details_text,
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
        github_client.handle_pr_results(all_issues, files_with_issues)

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
                    
    if task_id:
        logging.info("\n---  Assessing Task Relevance ---")
        
        review_summary = f"Found {len(all_issues)} issue(s)."
        
        relevance = relevance_assessor.assess_relevance(
            jira_details=jira_details_text,
            commit_messages=commit_messages,
            diff_text="\n".join(changed_files_map.values()),
            review_summary=review_summary,
            llm_config=llm_config
        )

        if relevance:
            comment_body = (
                f"🤖 **AI Assessment Complete for this PR**\n\n"
                f"/!\\ The code changes have a **{relevance.score}%** relevance score to this task.\n\n"
                f"**Justification:** {relevance.justification}"
            )
            jira_client.add_comment(task_id, comment_body)                    


    if not all_issues:
        logging.info("🎉 Great job! No issues found.")
    else:
        logging.info(f"\nFound a total of {len(all_issues)} issue(s).")

def main():
    app()

if __name__ == "__main__":
    main()