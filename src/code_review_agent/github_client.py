import os
import logging
from github import Github
from .models import CodeIssue
from collections import Counter

logger = logging.getLogger(__name__)

_client = None
_bot_user = None

def _get_github_client_and_user():
    """
    Initializes and returns the GitHub client and the bot's user info.
    Caches them for subsequent calls.
    """
    global _client, _bot_user
    if _client and _bot_user:
        return _client, _bot_user
            
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        logger.error("GITHUB_TOKEN environment variable is not set.")
        raise ValueError("GITHUB_TOKEN environment variable is not set.")
    
    try:
        client = Github(token)
        bot_user = client.get_user()
        logger.info(f"✅ Successfully authenticated to GitHub API as user: {bot_user.login}")
        _client = client
        _bot_user = bot_user
        return client, bot_user
    except Exception as e:
        logger.error(f"❌ CRITICAL: Failed to authenticate with GitHub. Check GITHUB_TOKEN permissions. Error: {e}", exc_info=True)
        raise ValueError("GitHub authentication failed.")


def handle_pr_results(all_issues: list[CodeIssue], files_with_issues: dict):
    """
    Main entry point for GitHub. Cleans old comments, then posts new issues or approves the PR.
    """
    try:
        client, bot_user = _get_github_client_and_user()
        repo_name = os.environ["GITHUB_REPOSITORY"]
        pr_number = int(os.environ["GITHUB_PR_NUMBER"])
        
        repo = client.get_repo(repo_name)
        pr = repo.get_pull(pr_number)

        logger.info("   - Searching for and deleting old bot comments...")
        
        review_comments = pr.get_review_comments()
        bot_comments = [c for c in review_comments if c.user.id == bot_user.id]
        
        logger.info(f"   - Found {len(bot_comments)} old comment(s) from this agent to delete.")
        for comment in bot_comments:
            try:
                comment.delete()
            except Exception as e:
                logger.warning(f"   - Could not delete comment {comment.id}: {e}")
        
        if not all_issues:
            logger.info("✅ No issues found. Posting approval comment and approving PR.")
            pr.create_issue_comment("Excellent work! The AI agent didn't find any issues. Keep up the great contributions! 🎉")
            pr.create_review(event="APPROVE")
            logger.info("✅ Successfully approved the Pull Request.")
        else:
            logger.info(f"   - Found {len(all_issues)} issue(s). Submitting a review with change requests.")
            
            comments_for_review = []
            latest_commit = pr.get_commits().reversed[0]
            for file_path, issues in files_with_issues.items():
                for issue in issues:
                    comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
                    if issue.suggestion:
                        comment_body += f"\n```suggestion\n{issue.suggestion}\n```"
                    
                    comments_for_review.append({
                        "path": file_path,
                        "line": issue.line_number,
                        "body": comment_body
                    })

            summary_body = _generate_summary_comment(all_issues)
            
            pr.create_review(
                commit=latest_commit,
                body=summary_body,
                event="REQUEST_CHANGES",
                comments=comments_for_review
            )
            logger.info("✅ Successfully submitted a review with change requests.")

    except Exception as e:
        logger.error(f"❌ An error occurred during the GitHub publishing process: {e}", exc_info=True)

def _generate_summary_comment(all_issues: list[CodeIssue]) -> str:
    """Helper function to create the summary comment body."""
    total_issues = len(all_issues)
    issue_counts = Counter(issue.issue_type for issue in all_issues)

    summary_body = f"### 🤖 AI Code Review Summary\n\nFound **{total_issues} potential issue(s)** that may require your attention.\n\n"
    if issue_counts:
        summary_body += "**Issue Breakdown:**\n"
        for issue_type, count in issue_counts.items():
            summary_body += f"* **{issue_type}:** {count} issue(s)\n"
    summary_body += "\n---\n*Please see the detailed inline comments below.*"
    return summary_body