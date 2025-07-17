import os
from atlassian import Bitbucket
from collections import Counter
from .models import CodeIssue

_client = None

def _get_bitbucket_client() -> Bitbucket:
    """
    Initializes and returns the Bitbucket client, performing an authentication check.
    """
    global _client
    if _client:
        return _client

    username = os.environ.get("BITBUCKET_APP_USERNAME")
    password = os.environ.get("BITBUCKET_APP_PASSWORD")

    if not username or not password:
        raise ValueError("BITBUCKET_APP_USERNAME or BITBUCKET_APP_PASSWORD not set.")
        
    try:
        client = Bitbucket(
            url="https://bitbucket.org",
            username=username,
            password=password
        )
        
        # pylint: disable=no-member
        user_info = client.get_user_info()
        print(f"✅ Successfully authenticated to Bitbucket API as user: {user_info.get('display_name')}")
        
        _client = client
        return _client
    except Exception as e:
        print(f"❌ CRITICAL: Failed to authenticate Bitbucket client: {e}")
        raise

def post_pr_comment(issue: CodeIssue, file_path: str):
    """Posts a single review comment to a specific line in a Bitbucket Pull Request."""
    try:
        client = _get_bitbucket_client()
        workspace = os.environ["BITBUCKET_WORKSPACE"]
        repo_slug = os.environ["BITBUCKET_REPO_SLUG"]
        pr_id = int(os.environ["BITBUCKET_PR_ID"])

        comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
        if issue.suggestion:
            comment_body += f"\n\n**Suggestion:**\n```\n{issue.suggestion}\n```"
        
        # pylint: disable=no-member
        client.pull_requests.comment(
            workspace=workspace,
            repository_slug=repo_slug,
            pull_request_id=pr_id,
            comment=comment_body,
            file=file_path,
            line_to=issue.line_number
        )
        
        print(f"✅ Successfully posted a comment to Bitbucket PR #{pr_id} on file {file_path}.")
    except Exception as e:
        print(f"❌ Failed to post line comment to Bitbucket: {e}")

def post_summary_comment(all_issues: list[CodeIssue]):
    """Posts a single summary comment to the Bitbucket Pull Request."""
    if not all_issues:
        return

    print("📝 Generating and posting summary comment to Bitbucket...")
    try:
        client = _get_bitbucket_client()
        workspace = os.environ["BITBUCKET_WORKSPACE"]
        repo_slug = os.environ["BITBUCKET_REPO_SLUG"]
        pr_id = int(os.environ["BITBUCKET_PR_ID"])

        total_issues = len(all_issues)
        issue_counts = Counter(issue.issue_type for issue in all_issues)
        summary_body = f"### 🤖 AI Code Review Summary\n\nFound **{total_issues} potential issue(s)**.\n\n"
        if issue_counts:
            summary_body += "**Issue Breakdown:**\n"
            for issue_type, count in issue_counts.items():
                summary_body += f"* **{issue_type}:** {count} issue(s)\n"
        summary_body += "\n---\n*Please see the detailed inline comments on the \"Diff\" tab for more context.*"

        # pylint: disable=no-member
        client.pull_requests.comment(
            workspace=workspace,
            repository_slug=repo_slug,
            pull_request_id=pr_id,
            comment=summary_body
        )
        
        print("✅ Successfully posted the summary comment to Bitbucket.")
    except Exception as e:
        print(f"❌ An unexpected error occurred while posting the summary comment: {e}")