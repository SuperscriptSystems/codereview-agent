import os
import typer
import yaml
from typing_extensions import Annotated

from . import git_utils, context_builder, reviewer

app = typer.Typer()

MAX_ITERATIONS = 5
MAX_CONTEXT_FILES = 20

def load_config(repo_path: str) -> dict:
    config_path = os.path.join(repo_path, '.codereview.yml')
    try:
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        print("⚠️ .codereview.yml not found. Proceeding with defaults.")
        return {
            'filtering': {'ignored_extensions': [], 'ignored_paths': []},
            'review_rules': [],
            'llm': {}
        }

@app.command()
def review(
    repo_path: Annotated[str, typer.Option(help="Path to the local Git repository.")] = ".",
    head_ref: Annotated[str, typer.Option(help="The commit hash or ref to review.")] = "HEAD",
    base_ref: Annotated[str, typer.Option(help="The base commit/ref to compare against.")] = "HEAD~1"
):
    typer.secho(f"🚀 Starting review for range {base_ref}..{head_ref} in repo '{repo_path}'...", fg=typer.colors.CYAN)
    

    config = load_config(repo_path)
    filtering_config = config.get('filtering', {})
    
    typer.echo("🔍 Gathering initial data...")
    diff = git_utils.get_diff(repo_path, base_ref, head_ref)
    commit_messages = git_utils.get_commit_messages(repo_path, base_ref, head_ref)
    changed_files_content = git_utils.get_changed_files_content(repo_path, diff)
    file_structure = git_utils.get_file_structure(
        repo_path,
        filtering_config.get('ignored_paths', []),
        filtering_config.get('ignored_extensions', [])
    )
    
    if not changed_files_content:
        typer.secho("✅ No changed files detected to review.", fg=typer.colors.GREEN)
        return


    final_context_files = list(changed_files_content.keys())

    for i in range(MAX_ITERATIONS):
        typer.secho(f"\n--- Context Building Iteration {i + 1}/{MAX_ITERATIONS} ---", bold=True)
        
        context_req = context_builder.determine_context(
            diff=diff,
            commit_messages=commit_messages,
            changed_files_content=changed_files_content,
            file_structure=file_structure,
            current_context_files=final_context_files,
            llm_config=config.get('llm', {})
        )

        typer.echo(f"🧠 Agent reasoning: {context_req.reasoning}")

        if context_req.is_sufficient or not context_req.required_additional_files:
            typer.secho("✅ Context is sufficient.", fg=typer.colors.GREEN)
            break

        new_files = [f for f in context_req.required_additional_files if f not in final_context_files]
        if not new_files:
            typer.secho("✅ Agent requested existing files. Context is considered sufficient.", fg=typer.colors.GREEN)
            break
        
        final_context_files.extend(new_files)
        typer.echo(f"➕ Adding {len(new_files)} new files to context: {new_files}")

        if len(final_context_files) > MAX_CONTEXT_FILES:
            typer.secho(f"⚠️ Warning: Context file count ({len(final_context_files)}) exceeds limit of {MAX_CONTEXT_FILES}.", fg=typer.colors.YELLOW)
            break
    else:
        typer.secho(f"⚠️ Warning: Reached max iterations ({MAX_ITERATIONS}).", fg=typer.colors.YELLOW)


    typer.echo("\n📚 Preparing full context for review...")
    full_context_content = {}
    for path in final_context_files:
        full_context_content[path] = git_utils.get_file_content(repo_path, path)

    # 5. Фаза 2: Рев'ю
    typer.secho("\n--- Starting Code Review Phase ---", bold=True)
    review_results = reviewer.run_review(
        changed_files_to_review=list(changed_files_content.keys()),
        full_context_content=full_context_content,
        review_rules=config.get('review_rules', []),
        llm_config=config.get('llm', {})
    )

    typer.secho("\n\n--- 🏁 Review Complete ---", bold=True, fg=typer.colors.BRIGHT_MAGENTA)
    total_issues = 0
    for file_path, result in review_results.items():
        if result.issues:
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