import os
import yaml
import typer
from typing_extensions import Annotated
from dotenv import load_dotenv

from . import git_utils, context_builder, reviewer

app = typer.Typer()


def load_config(repo_path: str) -> dict:
    config_path = os.path.join(repo_path, '.codereview.yml')
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        typer.secho("Info: .codereview.yml not found. Using defaults.", fg=typer.colors.BLUE)
        return {
            'filtering': {'ignored_extensions': [], 'ignored_paths': []},
            'review_rules': [],
            'llm': {}
        }

@app.command()
def review(
    repo_path: Annotated[str, typer.Option("--repo-path", help="Path to the local Git repository.")] = ".",
    base_ref: Annotated[str, typer.Option(help="The base commit/ref to compare against.")] = "HEAD~1",
    head_ref: Annotated[str, typer.Option(help="The commit hash or ref to review.")] = "HEAD",
    staged: Annotated[bool, typer.Option(help="Review only staged files instead of a commit range.")] = False,
):
    """
    Performs an AI-powered, context-aware code review using an iterative context-building approach.
    """
    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        typer.secho("Error: OPENAI_API_KEY is not set.", fg=typer.colors.RED, err=True)
        raise typer.Exit(code=1)

    config = load_config(repo_path)
    # enough 3 iteration to ensure 95% results and prevent cyclicality for all LLMs
    max_iterations = config.get('max_context_iterations', 3)
    max_context_files = config.get('max_context_files', 25)
    llm_config = config.get('llm', {})

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
        newly_found_files = git_utils.find_files_by_names(repo_path, context_req.required_additional_files)
        
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
    review_results = reviewer.run_review(
        changed_files_to_review=list(changed_files_content.keys()),
        full_context_content=final_context_content,
        review_rules=config.get('review_rules', []),
        llm_config=llm_config
    )

    typer.secho("\n\n--- 🏁 Review Complete ---", bold=True, fg=typer.colors.BRIGHT_MAGENTA)
    total_issues = 0
    for file_path, result in review_results.items():
        if not result.is_ok():
            total_issues += len(result.issues)
            typer.secho(f"\n🚨 Issues in `{file_path}`:", fg=typer.colors.YELLOW, bold=True)
            for issue in result.issues:
                typer.secho(f"  - L{issue.line_number} [{issue.issue_type}]: ", fg=typer.colors.RED, nl=False)
                typer.echo(issue.comment)
                if issue.suggestion:
                    typer.secho(f"    💡 Suggestion:", fg=typer.colors.CYAN)
                    typer.echo(f"    ```\n    {issue.suggestion}\n    ```")

    if total_issues == 0:
        typer.secho("\n🎉 Great job! No issues found.", fg=typer.colors.GREEN, bold=True)
    else:
        typer.secho(f"\nFound a total of {total_issues} issue(s).", fg=typer.colors.YELLOW)

def main():
    app()

if __name__ == "__main__":
    main()