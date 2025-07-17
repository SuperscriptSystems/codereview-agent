import os
import yaml
import typer
from typing import List, Optional
from typing_extensions import Annotated
from dotenv import load_dotenv

from . import git_utils, context_builder, reviewer
from .models import IssueType, CodeIssue



app = typer.Typer()


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
        typer.secho(f"Warning: Could not load or parse .codereview.yml: {e}. Using defaults.", fg=typer.colors.YELLOW)
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
):
    """
    Performs an AI-powered, context-aware code review using an iterative context-building approach.
    """
    load_dotenv()
    if not os.getenv("LLM_API_KEY"):
        typer.secho("Error: LLM_API_KEY is not set.", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    config = load_config(repo_path)
    # enough 3 iteration to ensure 95% results and prevent cyclicality for all LLMs
    max_iterations = config.get('max_context_iterations', 3)
    max_context_files = config.get('max_context_files', 25)
    llm_config = config.get('llm', {})
    filtering_config = config.get('filtering', {})

    typer.secho("🔍 Gathering initial data...", fg=typer.colors.BLUE)
    
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
        typer.echo("🎯 Using focus areas from command line arguments.")
        
    elif 'review_focus' in config and config['review_focus']:
        final_focus_areas = config['review_focus']
        typer.echo("🎯 Using focus areas from .codereview.yml config file.")
    else:
        final_focus_areas = POSSIBLE_FOCUS_AREAS
        typer.echo("🎯 No focus specified. Checking all available areas by default.")


    typer.secho("🔍 Gathering initial data...", fg=typer.colors.BLUE)

    if staged:
        typer.secho("Mode: Reviewing STAGED files.", bold=True)
        staged_data = git_utils.get_staged_diff_content(repo_path)

        diff = "\n".join([v['diff'] for v in staged_data.values()])
        changed_files_content = {path: data['content'] for path, data in staged_data.items()}
        commit_messages = "Reviewing staged files before commit."
    else:
        typer.secho(f"Mode: Reviewing commit range {base_ref}..{head_ref}", bold=True)
        diff = git_utils.get_diff(repo_path, base_ref, head_ref)
        commit_messages = git_utils.get_commit_messages(repo_path, base_ref, head_ref)
        changed_file_paths = git_utils.get_changed_files_from_diff(diff)
        changed_files_content = {
            path: git_utils.get_file_content(repo_path, path) for path in changed_file_paths
        }

    if not changed_files_content:
        typer.secho("✅ No changed files detected to review.", fg=typer.colors.GREEN)
        raise typer.Exit()

    
    final_context_content = dict(changed_files_content)

    for i in range(max_iterations):
        typer.secho(f"\n--- Context Building Iteration {i + 1}/{max_iterations} ---", bold=True)
        
        context_file_structure = git_utils.get_file_structure_from_paths(list(final_context_content.keys()))
        
        context_req = context_builder.determine_context(
            diff=diff,
            commit_messages=commit_messages,
            changed_files_content=changed_files_content,
            file_structure=context_file_structure,
            current_context_files=list(final_context_content.keys()),
            llm_config=llm_config,
        )

        typer.echo(f"🧠 Agent reasoning: {context_req.reasoning}")

        if context_req.is_sufficient or not context_req.required_additional_files:
            typer.secho("✅ Context is now sufficient.", fg=typer.colors.GREEN)
            break

        typer.echo(f"🔎 Searching for requested files: {context_req.required_additional_files}")
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


    typer.secho("\n--- Starting Code Review Phase ---", bold=True)
    typer.echo(f"🎯 Review focus: {', '.join(final_focus_areas)}")


    review_results = reviewer.run_review(
        changed_files_to_review=list(changed_files_content.keys()),
        full_context_content=final_context_content,
        review_rules=config.get('review_rules', []),
        llm_config=llm_config,
        focus_areas=final_focus_areas  
    )

    typer.secho("\n\n--- 🏁 Review Complete ---", bold=True, fg=typer.colors.BRIGHT_MAGENTA)

    all_issues: List[CodeIssue] = []
    files_with_issues = {}
    for file_path, result in review_results.items():
        if not result.is_ok():
            all_issues.extend(result.issues)
            files_with_issues[file_path] = result.issues

    is_bitbucket_pr = "BITBUCKET_PR_ID" in os.environ

    if is_bitbucket_pr and all_issues:
        typer.echo("🚀 Publishing results to Bitbucket PR...")
        from . import bitbucket_client 
        for file_path, issues in files_with_issues.items():
            for issue in issues:
                bitbucket_client.post_pr_comment(issue, file_path)
        bitbucket_client.post_summary_comment(all_issues)
    
    elif not is_bitbucket_pr and all_issues:
        for file_path, issues in files_with_issues.items():
            typer.secho(f"\n🚨 Issues in `{file_path}`:", fg=typer.colors.YELLOW, bold=True)
            for issue in issues:
                typer.secho(f"  - L{issue.line_number} [{issue.issue_type}]: ", fg=typer.colors.RED, nl=False)
                typer.echo(issue.comment)
                if issue.suggestion:
                    typer.secho(f"    💡 Suggestion:", fg=typer.colors.CYAN)
                    typer.echo(f"    ```\n    {issue.suggestion}\n    ```")


    if not all_issues:
        typer.secho("\n🎉 Great job! No issues found.", fg=typer.colors.GREEN, bold=True)
    else:
        typer.secho(f"\nFound a total of {len(all_issues)} issue(s).", fg=typer.colors.YELLOW)

def main():
    app()

if __name__ == "__main__":
    main()