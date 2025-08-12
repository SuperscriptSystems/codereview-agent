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
    Main entry point for GitHub. Cleans old comments, then posts new issues or approves the PR.
    """
    try:
        client = _get_github_client()
        repo_name = os.environ["GITHUB_REPOSITORY"]
        pr_number = int(os.environ["GITHUB_PR_NUMBER"])
        
        repo = client.get_repo(repo_name)
        pr = repo.get_pull(pr_number)

        logger.info("   - Searching for and deleting old bot comments...")
        
        BOT_LOGIN = "github-actions[bot]"
        
        _cleanup_unanswered_comments(pr, BOT_LOGIN)
        
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
                        "body": comment_body,
                        "side": "RIGHT"
                    })

            summary_body = _generate_summary_comment(all_issues)
            
            MAX_COMMENTS_PER_REVIEW = 30
            for i in range(0, len(comments_for_review), MAX_COMMENTS_PER_REVIEW):
                chunk = comments_for_review[i:i + MAX_COMMENTS_PER_REVIEW]
                
                current_body = summary_body if i == 0 else ""
                
                pr.create_review(
                    commit=latest_commit,
                    body=current_body,
                    event="REQUEST_CHANGES",
                    comments=chunk
                )
            logger.info("✅ Successfully submitted a review with change requests.")

    except GithubException as e:
        logger.error("❌ A GitHub API error occurred during the publishing process!")
        logger.error(f"   - Status: {e.status}")
        logger.error(f"   - Details: {e.data}")
        raise e 
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


def _cleanup_unanswered_comments(pr, bot_login: str):
    """Finds and deletes all previous, UNANSWERED comments made by the bot."""
    logger.info(f"--- Searching for and deleting old, unanswered comments from bot: {bot_login} ---")
    
    parent_comment_ids = set()
    review_comments = pr.get_review_comments()
    for comment in review_comments:
        if comment.in_reply_to_id:
            parent_comment_ids.add(comment.in_reply_to_id)
            
    bot_comments_to_delete = []
    for comment in review_comments:
        if comment.user and comment.user.login == bot_login:
            if comment.id not in parent_comment_ids:
                bot_comments_to_delete.append(comment)
    
    logger.info(f"   - Found {len(bot_comments_to_delete)} unanswered inline comment(s) to delete.")
    for comment in bot_comments_to_delete:
        try:
            comment.delete()
        except Exception as e:
            logger.warning(f"   - Could not delete inline comment {comment.id}: {e}")

    issue_comments = pr.get_issue_comments()
    for comment in issue_comments:
        if comment.user and comment.user.login == bot_login and "AI Code Review Summary" in comment.body:
            try:
                comment.delete()
                logger.info(f"   - Deleted old summary comment (ID: {comment.id}).")
            except Exception as e:
                logger.warning(f"   - Could not delete summary comment {comment.id}: {e}")
    
    logger.info("Cleanup complete")