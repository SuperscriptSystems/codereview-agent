import os
import requests
from requests.auth import HTTPBasicAuth
from collections import Counter
from .models import CodeIssue


def _get_api_details():
    """
    Helper function to get all necessary details from environment variables.
    This function should only be called when we know we are in a Bitbucket environment.
    """
    try:
        username = os.environ["BITBUCKET_APP_USERNAME"]
        app_password = os.environ["BITBUCKET_APP_PASSWORD"]
        workspace = os.environ["BITBUCKET_WORKSPACE"]
        repo_slug = os.environ["BITBUCKET_REPO_SLUG"]
        pr_id = os.environ["BITBUCKET_PR_ID"]
    except KeyError as e:
        raise ValueError(f"Required Bitbucket environment variable is not set: {e}")

    base_url = f"https://api.bitbucket.org/2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}"
    auth = HTTPBasicAuth(username, app_password)
    headers = {"Content-Type": "application/json"}
    
    return base_url, auth, headers


def post_pr_comment(issue: CodeIssue, file_path: str):
    """Posts a single review comment to a specific line in a Bitbucket Pull Request."""
    try:
        base_url, auth, headers = _get_api_details()
        url = f"{base_url}/comments"

        comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
        if issue.suggestion:
            comment_body += f"\n\n**Suggestion:**\n```\n{issue.suggestion}\n```"

        payload = {
            "content": {"raw": comment_body},
            "inline": {
                "path": file_path,
                "to": issue.line_number
            }
        }

        response = requests.post(url, headers=headers, auth=auth, json=payload)
        response.raise_for_status()

        print(f"✅ Successfully posted comment to PR on file {file_path}.")
    except (ValueError, requests.exceptions.RequestException) as e:
        print(f"❌ Failed to post line comment: {e}")


def post_summary_comment(all_issues: list[CodeIssue]):
    """Posts a single summary comment to the Bitbucket Pull Request."""
    if not all_issues:
        return

    print("📝 Generating and posting summary comment to Bitbucket...")
    try:
        total_issues = len(all_issues)
        issue_counts = Counter(issue.issue_type for issue in all_issues)

        summary_body = f"### 🤖 AI Code Review Summary\n\nFound **{total_issues} potential issue(s)**.\n\n"
        if issue_counts:
            summary_body += "**Issue Breakdown:**\n"
            for issue_type, count in issue_counts.items():
                summary_body += f"* **{issue_type}:** {count} issue(s)\n"
        summary_body += "\n---\n*Please see the detailed inline comments on the \"Diff\" tab for more context.*"

        base_url, auth, headers = _get_api_details()
        url = f"{base_url}/comments"
        payload = {
            "content": {"raw": summary_body}
        }

        response = requests.post(url, headers=headers, auth=auth, json=payload)
        response.raise_for_status()

        print("✅ Successfully posted the summary comment to Bitbucket.")
    except (ValueError, requests.exceptions.RequestException) as e:
        print(f"❌ Failed to post summary comment: {e}")
