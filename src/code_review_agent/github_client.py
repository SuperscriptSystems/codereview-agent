import os
import logging
from github import Github
from github import GithubException
from .models import CodeIssue
from collections import Counter

logger = logging.getLogger(__name__)

_client = None

def _get_github_client():
    """
    Initializes and returns the GitHub client and the bot's user info.
    Caches them for subsequent calls.
    """
    global _client
    if _client:
        return _client

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        logger.error("GITHUB_TOKEN environment variable is not set.")
        raise ValueError("GITHUB_TOKEN environment variable is not set.")
    
    try:
        client = Github(token)
        _client = client
        return client
    except Exception as e:
        logger.error(f"❌ CRITICAL: Failed to authenticate with GitHub. Check GITHUB_TOKEN permissions. Error: {e}", exc_info=True)
        raise ValueError("GitHub authentication failed.")
    

def handle_pr_results(all_issues: list[CodeIssue], files_with_issues: dict):
    """
    Main entry point for GitHub. Cleans old comments, then posts new results.
    - Deletes old, UNANSWERED inline comments.
    - Deletes ALL old summary comments.
    """
    try:
        client = _get_github_client()
        repo_name = os.environ["GITHUB_REPOSITORY"]
        pr_number = int(os.environ["GITHUB_PR_NUMBER"])
        
        repo = client.get_repo(repo_name)
        pr = repo.get_pull(pr_number)
        
        BOT_LOGIN = "github-actions[bot]"

        _cleanup_comments(pr, BOT_LOGIN)

        if all_issues:
            logger.info(f"   - Found {len(all_issues)} issue(s). Submitting a new review.")
            _post_review_with_issues(pr, all_issues, files_with_issues)
        else:
            logger.info("✅ No issues found. Leaving an approval comment.")
            _dismiss_previous_reviews(pr, BOT_LOGIN)
            pr.create_issue_comment("Excellent work! The AI agent didn't find any issues. 👍")

    except Exception as e:
        logger.error(f"❌ An error occurred during the GitHub publishing process: {e}", exc_info=True)

def _cleanup_comments(pr, bot_login: str):
    """
    Cleans up old comments:
    - Deletes unanswered inline comments.
    - Deletes ALL summary comments from the bot.
    """
    logger.info(f"--- Cleaning up comments from bot: {bot_login} ---")
    
    review_comments = pr.get_review_comments()
    parent_comment_ids = {c.in_reply_to_id for c in review_comments if c.in_reply_to_id}
            
    bot_inline_comments_to_delete = [
        c for c in review_comments 
        if c.user and c.user.login == bot_login and c.id not in parent_comment_ids
    ]
    
    logger.info(f"   - Found {len(bot_inline_comments_to_delete)} unanswered inline comment(s) to delete.")
    for comment in bot_inline_comments_to_delete:
        try:
            comment.delete()
        except Exception as e:
            logger.warning(f"   - Could not delete inline comment {comment.id}: {e}")
    
    issue_comments = pr.get_issue_comments()
    bot_summary_comments_to_delete = [
        c for c in issue_comments
        if c.user and c.user.login == bot_login
    ]
    
    logger.info(f"   - Found {len(bot_summary_comments_to_delete)} summary/approval comment(s) to delete.")
    for comment in bot_summary_comments_to_delete:
        try:
            comment.delete()
        except Exception as e:
            logger.warning(f"   - Could not delete summary comment {comment.id}: {e}")
            
    logger.info("--- Cleanup complete ---")

def _dismiss_previous_reviews(pr, bot_login: str):
    """Finds and dismisses any previous reviews from the bot that requested changes."""
    for review in pr.get_reviews():
        if review.user and review.user.login == bot_login and review.state == 'CHANGES_REQUESTED':
            try:
                review.dismiss("All previous issues appear to be addressed.")
                logger.info(f"   - Dismissed previous 'CHANGES_REQUESTED' review (ID: {review.id}).")
            except Exception as e:
                logger.warning(f"   - Could not dismiss review {review.id}: {e}")


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

def _post_review_with_issues(pr, all_issues: list[CodeIssue], files_with_issues: dict):
    """Posts all new issues and a summary comment as a single review."""
    latest_commit = pr.get_commits().reversed[0]
    
    comments_for_review = []
    for file_path, issues in files_with_issues.items():
        for issue in issues:
            comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
            if issue.suggestion:
                comment_body += f"\n```suggestion\n{issue.suggestion}\n```"
            comments_for_review.append({
                "path": file_path, "line": issue.line_number, "body": comment_body, "side": "RIGHT"
            })

    summary_body = _generate_summary_comment(all_issues)
    
    pr.create_issue_comment(summary_body)
    

    MAX_COMMENTS_PER_REQUEST = 30
    for i in range(0, len(comments_for_review), MAX_COMMENTS_PER_REQUEST):
        chunk = comments_for_review[i:i + MAX_COMMENTS_PER_REQUEST]
        pr.create_review(commit=latest_commit, comments=chunk, event="COMMENT")

    if all_issues:
        pr.create_review(event="REQUEST_CHANGES")

    logger.info("✅ Successfully submitted review.")