import os
import logging
from github import Github
from .models import CodeIssue
from collections import Counter

logger = logging.getLogger(__name__)

_client = None

def _get_github_client():
    global _client
    if _client:
        return _client
        
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        logger.error("GITHUB_TOKEN environment variable is not set.")
        raise ValueError("GITHUB_TOKEN environment variable not set.")
    
    _client = Github(token)
    return _client

def post_pr_comment(issue: CodeIssue, file_path: str):
    try:
        client = _get_github_client()
        repo_name = os.environ["GITHUB_REPOSITORY"]
        pr_number = int(os.environ["GITHUB_PR_NUMBER"])
        
        repo = client.get_repo(repo_name)
        pr = repo.get_pull(pr_number)
        latest_commit = pr.get_commits().reversed[0]

        comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
        if issue.suggestion:
            comment_body += f"\n```suggestion\n{issue.suggestion}\n```"

        pr.create_review_comment(
            body=comment_body,
            commit=latest_commit,
            path=file_path,
            line=issue.line_number
        )
        logger.info(f"✅ Successfully posted a comment to GitHub PR #{pr_number}.")
    except Exception as e:
        logger.error(f"❌ Failed to post comment to GitHub: {e}", exc_info=True)

def post_summary_comment(all_issues: list[CodeIssue]):
    """Posts a single summary comment with an overview of all found issues."""
    if not all_issues:
        return

    logger.info("📝 Generating and posting summary comment to GitHub...")
    try:
        client = _get_github_client()
        repo_name = os.environ["GITHUB_REPOSITORY"]
        pr_number = int(os.environ["GITHUB_PR_NUMBER"])
        
        repo = client.get_repo(repo_name)
        pr = repo.get_pull(pr_number)

        total_issues = len(all_issues)
        issue_counts = Counter(issue.issue_type for issue in all_issues)
        
        summary_body = f"### 🤖 AI Code Review Summary\n\nFound **{total_issues} potential issue(s)**.\n\n"
        
        if issue_counts:
            summary_body += "**Issue Breakdown:**\n"
            for issue_type, count in issue_counts.items():
                summary_body += f"- **{issue_type}:** {count} issue(s)\n"
        
        summary_body += "\n---\n*Please see the detailed inline comments on the \"Files changed\" tab for more context.*"

        pr.create_issue_comment(summary_body)

        logger.info("✅ Successfully posted the summary comment to GitHub.")
    except Exception as e:
        logger.error(f"❌ An unexpected error occurred while posting the summary comment to GitHub: {e}", exc_info=True)