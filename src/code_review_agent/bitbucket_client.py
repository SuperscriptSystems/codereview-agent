import os
import json
from atlassian import Bitbucket
from collections import Counter
from .models import CodeIssue

_client = None

def _get_bitbucket_client() -> Bitbucket:
    """
    Initializes and returns the Bitbucket client using a direct API call for auth check.
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
            url="https://api.bitbucket.org",
            username=username,
            password=password
        )
        
        response = client.get('2.0/user')
        
        print(f"✅ Successfully authenticated to Bitbucket API as user: {response.get('display_name')}")
        
        _client = client
        return _client
    except Exception as e:
        print(f"❌ CRITICAL: Failed to authenticate Bitbucket client. Please check credentials. Error: {e}")
        raise

def post_pr_comment(issue: CodeIssue, file_path: str):
    """Posts a single review comment to a specific line via direct API call."""
    try:
        client = _get_bitbucket_client()
        workspace = os.environ["BITBUCKET_WORKSPACE"]
        repo_slug = os.environ["BITBUCKET_REPO_SLUG"]
        pr_id = int(os.environ["BITBUCKET_PR_ID"])

        url = f'2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments'
        
        comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
        if issue.suggestion:
            comment_body += f"\n\n**Suggestion:**\n```\n{issue.suggestion}\n```"

        payload = {
            "content": {"raw": comment_body},
            "inline": {"path": file_path, "to": issue.line_number}
        }
        
        client.post(url, data=json.dumps(payload))
        
        print(f"✅ Successfully posted a comment to Bitbucket PR #{pr_id} on file {file_path}.")
    except Exception as e:
        print(f"❌ Failed to post line comment to Bitbucket: {e}")

def post_summary_comment(all_issues: list[CodeIssue]):
    """Posts a single summary comment via direct API call."""
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

        url = f'2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}/comments'
        payload = {"content": {"raw": summary_body}}
        
        client.post(url, data=json.dumps(payload))
        
        print("✅ Successfully posted the summary comment to Bitbucket.")
    except Exception as e:
        print(f"❌ An unexpected error occurred while posting the summary comment: {e}")