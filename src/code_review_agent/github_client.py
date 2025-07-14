import os
from github import Github, GithubException
from .models import CodeIssue
from collections import Counter

_github_client = None
_pull_request = None

def _get_github_client():
    global _github_client
    if _github_client is None:
        token = os.environ.get("GITHUB_TOKEN")
        if not token:
            raise ValueError("GITHUB_TOKEN environment variable is not set.")
        _github_client = Github(token)
    return _github_client

def _get_pull_request():
    global _pull_request
    if _pull_request is None:
        try:
            pr_number = int(os.environ["GITHUB_PR_NUMBER"])
            repo_name = os.environ["GITHUB_REPOSITORY"]
        except (KeyError, ValueError) as e:
            raise ValueError(f"Required environment variable for GitHub is not set: {e}")

        g = _get_github_client()
        repo = g.get_repo(repo_name)
        _pull_request = repo.get_pull(pr_number)
    return _pull_request

def post_review_comment(issue: CodeIssue, file_path: str):
    try:
        pr = _get_pull_request()
        latest_commit = pr.get_commits().reversed[0]

        pr.create_review_comment(
            body=f"**[{issue.issue_type}]**\n\n{issue.comment}",
            commit_id=latest_commit.sha,
            path=file_path,
            line=issue.line_number
        )
        print(f"✅ Successfully posted a comment to '{file_path}' at line {issue.line_number}.")

    except GithubException as e:
        print(f"⚠️ Could not post comment to line {issue.line_number} in '{file_path}'. "
              f"This line might not be part of the PR changes. Error: {e.data['errors'][0]['message']}")
    except Exception as e:
        print(f"❌ An unexpected error occurred while posting a comment to GitHub: {e}")



def post_summary_comment(all_issues: list[CodeIssue]):
    print("📝 Generating and posting summary comment...")
    try:
        pr = _get_pull_request()
        

        total_issues = len(all_issues)
        issue_counts = Counter(issue.issue_type for issue in all_issues)
        

        summary_body = f"## 🤖 Code Review Summary\n\n"
        summary_body += f"I've analyzed the changes and found **{total_issues} issue(s)** that may require your attention.\n\n"
        
        if issue_counts:
            summary_body += "### Issue Breakdown:\n"
            for issue_type, count in issue_counts.items():
                summary_body += f"- **{issue_type}:** {count} issue(s)\n"
        
        summary_body += "\n*Please see the detailed comments on the \"Files changed\" tab for more context.*"


        pr.create_issue_comment(summary_body)
        print("✅ Successfully posted the summary comment.")

    except Exception as e:
        print(f"❌ An unexpected error occurred while posting the summary comment: {e}")