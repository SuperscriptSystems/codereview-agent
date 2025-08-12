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
    Main entry point for GitHub. Cleans old inline comments, updates the summary,
    and posts new results as a single review.
    """
    try:
        client = _get_github_client()
        repo_name = os.environ["GITHUB_REPOSITORY"]
        pr_number = int(os.environ["GITHUB_PR_NUMBER"])
        
        repo = client.get_repo(repo_name)
        pr = repo.get_pull(pr_number)
        
        BOT_LOGIN = "github-actions[bot]"

        _cleanup_unanswered_inline_comments(pr, BOT_LOGIN)
        
        summary_body = _generate_summary_comment(all_issues)
        _update_or_create_summary_comment(pr, summary_body, BOT_LOGIN)

        if all_issues:
            _post_review_with_issues(pr, files_with_issues)
        else:
            _approve_pr(pr, BOT_LOGIN)
            
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


def _cleanup_unanswered_inline_comments(pr, bot_login: str):
    """Finds and deletes all previous, UNANSWERED inline comments made by the bot."""
    logger.info(f"--- Cleaning up unanswered inline comments from bot: {bot_login} ---")
    
    review_comments = pr.get_review_comments()
    parent_comment_ids = {c.in_reply_to_id for c in review_comments if c.in_reply_to_id}
            
    bot_comments_to_delete = [
        c for c in review_comments 
        if c.user and c.user.login == bot_login and c.id not in parent_comment_ids
    ]
    
    logger.info(f"   - Found {len(bot_comments_to_delete)} unanswered inline comment(s) to delete.")
    for comment in bot_comments_to_delete:
        try:
            comment.delete()
        except Exception as e:
            logger.warning(f"   - Could not delete inline comment {comment.id}: {e}")


def _update_or_create_summary_comment(pr, body: str, bot_login: str):
    """Finds an old summary comment and edits it, or creates a new one."""
    summary_comment = None
    for comment in pr.get_issue_comments():
        if comment.user and comment.user.login == bot_login and "AI Code Review Summary" in comment.body:
            summary_comment = comment
            break
    
    if summary_comment:
        logger.info(f"   - Found existing summary comment (ID: {summary_comment.id}). Updating it.")
        summary_comment.edit(body)
    else:
        logger.info("   - No existing summary comment found. Creating a new one.")
        pr.create_issue_comment(body)            


def _approve_pr(pr, bot_login: str):
    """Approves the PR if no issues are found, dismissing any previous change requests from the bot."""
    logger.info("✅ No issues found. Approving the PR.")
    
    for review in pr.get_reviews():
        if review.user and review.user.login == bot_login and review.state == 'CHANGES_REQUESTED':
            try:
                review.dismiss("All issues addressed.")
                logger.info(f"   - Dismissed previous review (ID: {review.id}).")
            except Exception as e:
                logger.warning(f"   - Could not dismiss review {review.id}: {e}")
    
    pr.create_review(event="APPROVE")
    logger.info("✅ Successfully approved the Pull Request.")        


def _post_review_with_issues(pr, files_with_issues: dict):
    """Posts all new issues as a single review with 'REQUEST_CHANGES' status."""
    logger.info(f"   - Submitting a review with {len(files_with_issues)} file(s) containing issues.")
    comments_for_review = []
    latest_commit = pr.get_commits().reversed[0]
    for file_path, issues in files_with_issues.items():
        for issue in issues:
            comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
            if issue.suggestion:
                comment_body += f"\n```suggestion\n{issue.suggestion}\n```"
            comments_for_review.append({
                "path": file_path, "line": issue.line_number, "body": comment_body, "side": "RIGHT"
            })

    try:
        pr.create_review(
            commit=latest_commit,
            event="REQUEST_CHANGES",
            comments=comments_for_review
        )
        logger.info("✅ Successfully submitted a review with change requests.")
    except GithubException as e:
        if "comments must be a list of at most" not in str(e.data):
            raise