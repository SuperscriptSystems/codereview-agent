import os
import requests
from requests.auth import HTTPBasicAuth
from collections import Counter
from .models import CodeIssue

USERNAME = os.environ["BITBUCKET_USERNAME"]
APP_PASSWORD = os.environ["BITBUCKET_APP_PASSWORD"]
WORKSPACE = os.environ["BITBUCKET_WORKSPACE"]
REPO_SLUG = os.environ["BITBUCKET_REPO_SLUG"]
PR_ID = os.environ["BITBUCKET_PR_ID"]

BASE_URL = f"https://api.bitbucket.org/2.0/repositories/{WORKSPACE}/{REPO_SLUG}/pullrequests/{PR_ID}"
AUTH = HTTPBasicAuth(USERNAME, APP_PASSWORD)
HEADERS = {
    "Content-Type": "application/json"
}


def post_pr_comment(issue: CodeIssue, file_path: str):
    """Posts a single review comment to a specific line in a Bitbucket Pull Request."""
    url = f"{BASE_URL}/comments"

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

    response = requests.post(url, headers=HEADERS, auth=AUTH, json=payload)

    if response.status_code == 201:
        print(f"✅ Successfully posted comment to PR on file {file_path}.")
    else:
        print(f"❌ Failed to post line comment: {response.status_code} — {response.text}")


def post_summary_comment(all_issues: list[CodeIssue]):
    """Posts a single summary comment to the Bitbucket Pull Request."""
    if not all_issues:
        return

    print("📝 Generating and posting summary comment to Bitbucket...")

    total_issues = len(all_issues)
    issue_counts = Counter(issue.issue_type for issue in all_issues)

    summary_body = f"### 🤖 AI Code Review Summary\n\nFound **{total_issues} potential issue(s)**.\n\n"
    if issue_counts:
        summary_body += "**Issue Breakdown:**\n"
        for issue_type, count in issue_counts.items():
            summary_body += f"* **{issue_type}:** {count} issue(s)\n"
    summary_body += "\n---\n*Please see the detailed inline comments on the \"Diff\" tab for more context.*"

    url = f"{BASE_URL}/comments"
    payload = {
        "content": {"raw": summary_body}
    }

    response = requests.post(url, headers=HEADERS, auth=AUTH, json=payload)

    if response.status_code == 201:
        print("✅ Successfully posted the summary comment to Bitbucket.")
    else:
        print(f"❌ Failed to post summary comment: {response.status_code} — {response.text}")
