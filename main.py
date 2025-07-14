import os
from dotenv import load_dotenv
from src.code_review_agent.git_utils import get_staged_diff
from src.code_review_agent.reviewer import review_code_changes

SUPPORTED_FILE_EXTENSIONS = [
    '.py',
    '.js',
    '.ts',
    '.yaml',
    '.json',
    '.md',
    '.cs',
    '.csproj',  
    '.sln',    
    '.vb',      
    '.fs'       
]

def run_agent():
    load_dotenv()
    if not os.getenv("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY not found in .env file.")

    print("🚀 Starting Code Review Agent...")
    staged_diffs = get_staged_diff(allowed_extensions=SUPPORTED_FILE_EXTENSIONS)

    if not staged_diffs:
        print(f"✅ No staged files with supported extensions found to review. All clean!")
        return

    total_issues = 0
    for file_path, diff in staged_diffs.items():
        review_result = review_code_changes(file_path, diff)

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