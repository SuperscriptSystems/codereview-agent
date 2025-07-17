import os
from atlassian import Bitbucket
from collections import Counter
from .models import CodeIssue

_client = None

def _get_bitbucket_client() -> Bitbucket:
    """
    Initializes and returns the Bitbucket client based on environment variables.
    Caches the client for subsequent calls.
    """
    global _client
    if _client:
        return _client

    username = os.environ.get("BITBUCKET_APP_USERNAME")
    password = os.environ.get("BITBUCKET_APP_PASSWORD")

    if not username or not password:
        raise ValueError("BITBUCKET_APP_USERNAME or BITBUCKET_APP_PASSWORD not set.")
        
    client = Bitbucket(
        url="https://bitbucket.org",
        username=username,
        password=password
    )
    
    try:
        user_info = client.get_users_info(user_filter=username)
        print(f"✅ Successfully authenticated to Bitbucket API as user: {user_info}")
    except Exception as e:
        print(f"❌ CRITICAL: Failed to authenticate Bitbucket client: {e}")
        raise
        
    _client = client
    return _client

def post_pr_comment(issue: CodeIssue, file_path: str):
    """Posts a single review comment to the Bitbucket Pull Request."""
    try:
        client = _get_bitbucket_client()
        workspace = os.environ["BITBUCKET_WORKSPACE"]
        repo_slug = os.environ["BITBUCKET_REPO_SLUG"]
        pr_id = int(os.environ["BITBUCKET_PR_ID"])
        
				# pylint: disable=no-member
        client.repositories.post_pull_request_comment(
            workspace,
            repo_slug,
            pr_id,
            {
                "content": {
                    "raw": f"**[{issue.issue_type}]** {issue.comment}"
                },
                "inline": {
                    "path": file_path,
                    "to": issue.line_number
                }
            }
        )
        print(f"✅ Successfully posted a comment to Bitbucket PR #{pr_id}.")
    except Exception as e:
        print(f"❌ Failed to post comment to Bitbucket: {e}")

def post_summary_comment(all_issues: list[CodeIssue]):
    """
    Posts a single summary comment with an overview of all found issues.
    """
    if not all_issues:
        print("No issues found, skipping summary comment.")
        return

    print("📝 Generating and posting summary comment to Bitbucket...")
    try:
        client = _get_bitbucket_client()
        workspace = os.environ["BITBUCKET_WORKSPACE"]
        repo_slug = os.environ["BITBUCKET_REPO_SLUG"]
        pr_id = int(os.environ["BITBUCKET_PR_ID"])

      
        total_issues = len(all_issues)
        issue_counts = Counter(issue.issue_type for issue in all_issues)

        summary_body = f"### 🤖 AI Code Review Summary\n\n"
        summary_body += f"Found **{total_issues} potential issue(s)** that may require your attention.\n\n"
        
        if issue_counts:
            summary_body += "**Issue Breakdown:**\n"
            for issue_type, count in issue_counts.items():
                summary_body += f"* **{issue_type}:** {count} issue(s)\n"
        
        summary_body += "\n---\n*Please see the detailed inline comments on the \"Diff\" tab for more context.*"
        
				# pylint: disable=no-member
        client.repositories.post_pull_request_comment(
            workspace,
            repo_slug,
            pr_id,
            {
                "content": {
                    "raw": summary_body
                }
            }
        )
        print("✅ Successfully posted the summary comment to Bitbucket.")

    except Exception as e:
        print(f"❌ An unexpected error occurred while posting the summary comment to Bitbucket: {e}")