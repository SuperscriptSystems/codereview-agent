import os
import yaml
from dotenv import load_dotenv
from src.code_review_agent.git_utils import get_pr_diff, get_staged_diff
from src.code_review_agent.reviewer import review_code_changes

DEFAULT_CONFIG = {
    'supported_extensions': [
        # Python
        '.py',
        # Web
        '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.scss',
        # Config & Data
        '.yaml', '.yml', '.json', '.toml',
        # .NET Ecosystem
        '.cs', '.csproj', '.sln', '.vb', '.fs',
        # Docs & Scripts
        '.md', '.sh', 'Dockerfile'
    ]
}

def load_config() -> dict:

    try:
        with open('.codereview.yml', 'r', encoding='utf-8') as f:
            print("Info: Loading configuration from .codereview.yml")
            return yaml.safe_load(f)
    except FileNotFoundError:
        print("Info: .codereview.yml not found. Using default configuration.")
        return DEFAULT_CONFIG
    except Exception as e:
        print(f"Warning: Could not load or parse .codereview.yml: {e}. Using default configuration.")
        return DEFAULT_CONFIG


def run_agent():

    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY not found in .env file or environment variables.")

    config = load_config()
    supported_extensions = config.get('supported_extensions', DEFAULT_CONFIG['supported_extensions'])

    if os.environ.get('GITHUB_ACTIONS') == 'true':
        print("🚀 Starting Code Review Agent in PR mode...")
        changed_files = get_pr_diff(allowed_extensions=supported_extensions)
    else:
        print("🚀 Starting Code Review Agent in local staged mode...")
        changed_files = get_staged_diff(allowed_extensions=supported_extensions)

    if not changed_files:
        print("✅ No relevant file changes found to review.")
        return

    total_issues = 0
    for file_path, diff in changed_files.items():
        full_content = ""
        try:
           
            with open(file_path, 'r', encoding='utf-8') as f:
                full_content = f.read()
        except FileNotFoundError:
         
            print(f"Info: File '{file_path}' not found. It may have been deleted.")

        except Exception as e:
            print(f"Warning: Could not read file '{file_path}': {e}. Skipping content.")

        review_result = review_code_changes(file_path, diff, full_content)

        if not review_result.is_ok():
            print(f"🚨 Found issues in file: {file_path}")
            for issue in review_result.issues:
                total_issues += 1
                print(f"  - L{issue.line_number} [{issue.issue_type}]: {issue.comment}")
        else:
            print(f"✅ File {file_path} looks good!")

    print("\n---")
    if total_issues > 0:
        print(f"🏁 Review complete. Found {total_issues} issue(s) in total.")
    else:
        print("🎉 Great job! All reviewed files look good.")


if __name__ == "__main__":
    run_agent()