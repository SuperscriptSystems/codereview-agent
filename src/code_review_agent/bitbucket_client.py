import os
import requests
import logging
from requests.auth import HTTPBasicAuth
from collections import Counter
from .models import CodeIssue


logger = logging.getLogger(__name__)

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
        logger.error(f"Missing required Bitbucket environment variable: {e}")
        raise ValueError(f"Required Bitbucket environment variable is not set: {e}")

    base_url = f"https://api.bitbucket.org/2.0/repositories/{workspace}/{repo_slug}/pullrequests/{pr_id}"
    auth = HTTPBasicAuth(username, app_password)
    headers = {"Content-Type": "application/json"}
    
    bot_account_id = None
    try:
        auth_check_response = requests.get("https://api.bitbucket.org/2.0/user", auth=auth)
        auth_check_response.raise_for_status()

        bot_account_id = auth_check_response.json().get('account_id')
        
        logger.info(f"✅ Successfully authenticated to Bitbucket as user with account_id: {bot_account_id}")
    except requests.exceptions.RequestException as e:
        logger.error(f"❌ CRITICAL: Failed to authenticate with Bitbucket. Check credentials. Error: {e}")
        raise ValueError("Authentication failed.")
        
    return base_url, auth, headers, bot_account_id


def cleanup_and_post_all_comments(all_issues: list[CodeIssue], files_with_issues: dict):
    """
    Cleans up old comments from the bot and posts new ones.
    This is the main entry point from the CLI.
    """
    logger.info("🚀 Publishing results to Bitbucket PR...")
    try:
        base_url, auth, headers, bot_account_id = _get_api_details()

        if not bot_account_id:
            logger.error("Could not determine bot account ID. Skipping comment cleanup.")
            _publish_without_cleanup(all_issues, files_with_issues, base_url, auth, headers)
            return

        logger.info("   - Searching for and deleting old bot comments...")
        
        all_old_comments = []
        url = f"{base_url}/comments"
        
        while url:
            response = requests.get(url, auth=auth, headers=headers)
            response.raise_for_status()
            data = response.json()
            all_old_comments.extend(data.get('values', []))
            url = data.get('next', None)
            if url:
                logger.info(f"   - Fetching next page of comments...")
        
        bot_comments = [
            comment for comment in all_old_comments
            if (comment.get('user', {}).get('account_id') == bot_account_id)
        ]

        parent_comment_ids = {
            comment['parent']['id']
            for comment in all_old_comments
            if 'parent' in comment and comment.get('parent')
        }

        comments_to_delete = [
            comment for comment in bot_comments
            if comment['id'] not in parent_comment_ids
        ]


        logger.info(f"   - Found {len(bot_comments)} old comment(s) from this agent to delete.")
        logger.info(f"   - Found {len(comments_to_delete)} of them are unanswered and will be deleted.")


        if comments_to_delete:
            delete_url_template = f"{base_url}/comments"
            deletions_successful = 0
            for comment in comments_to_delete:
                delete_url = f"{delete_url_template}/{comment['id']}"
                try:
                    response = requests.delete(delete_url, auth=auth)
                    response.raise_for_status() 
                    deletions_successful += 1
                except requests.exceptions.RequestException as e:
                    logger.error(f"   - FAILED to delete comment ID {comment['id']}. Details: {e}")
            
            logger.info(f"   - Successfully deleted {deletions_successful} out of {len(comments_to_delete)} comment(s).")


        approve_url = f"{base_url}/approve"

        if not all_issues:
            logger.info("✅ No issues found. Posting approval comment and approving PR.")
            
            approve_comment_payload = {"content": {"raw": "Excellent work! The AI agent didn't find any issues. Keep up the great contributions! 🎉"}}
            requests.post(f"{base_url}/comments", headers=headers, auth=auth, json=approve_comment_payload)
            
            response = requests.post(approve_url, auth=auth)
            response.raise_for_status()
            logger.info("✅ Successfully approved the Pull Request.")
            
        else:
            logger.info(f"   - Found {len(all_issues)} issue(s). Posting comments.")
            
            requests.delete(approve_url, auth=auth)
            logger.info("   - Ensured PR is not approved by this agent (removed approval if existed).")    

        _publish_without_cleanup(all_issues, files_with_issues, base_url, auth, headers)

    except (ValueError, requests.exceptions.RequestException) as e:
        logger.error(f"❌ An error occurred during the publishing process: {e}", exc_info=True)


def _post_pr_comment(issue: CodeIssue, file_path: str, base_url: str, auth: HTTPBasicAuth, headers: dict):
    """Posts a single review comment to a specific line."""
    try:
        url = f"{base_url}/comments"
        comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
        if issue.suggestion:
            comment_body += f"\n\n**Suggestion:**\n```\n{issue.suggestion}\n```"

        payload = {
            "content": {"raw": comment_body},
            "inline": {"path": file_path, "to": issue.line_number}
        }
        response = requests.post(url, headers=headers, auth=auth, json=payload)
        response.raise_for_status()
        logger.info(f"✅ Successfully posted comment to PR on file {file_path}.")
    except requests.exceptions.RequestException as e:
        logger.error(f"❌ Failed to post line comment for file {file_path}: {e}", exc_info=True)


def _post_summary_comment(all_issues: list[CodeIssue], base_url: str, auth: HTTPBasicAuth, headers: dict):
    """Posts a single summary comment to the Bitbucket Pull Request."""
    if not all_issues:
        return

    logger.info("📝 Generating and posting summary comment to Bitbucket...")
    try:
        total_issues = len(all_issues)
        issue_counts = Counter(issue.issue_type for issue in all_issues)

        summary_body = f"### 🤖 AI Code Review Summary\n\nFound **{total_issues} potential issue(s)**.\n\n"
        if issue_counts:
            summary_body += "**Issue Breakdown:**\n"
            for issue_type, count in issue_counts.items():
                summary_body += f"* **{issue_type}:** {count} issue(s)\n"
        summary_body += "\n---\n*Please see the detailed inline comments on the \"Diff\" tab for more context.*"

        url = f"{base_url}/comments"
        payload = {
            "content": {"raw": summary_body}
        }

        response = requests.post(url, headers=headers, auth=auth, json=payload)
        response.raise_for_status()

        logger.info("✅ Successfully posted the summary comment to Bitbucket.")
    except (ValueError, requests.exceptions.RequestException) as e:
        logger.error(f"❌ Failed to post summary comment: {e}", exc_info=True)


def _publish_without_cleanup(all_issues: list[CodeIssue], files_with_issues: dict, base_url: str, auth: HTTPBasicAuth, headers: dict):
    """Helper function to post comments without cleaning up."""
    for file_path, issues in files_with_issues.items():
        for issue in issues:
            _post_pr_comment(issue, file_path, base_url, auth, headers)
    _post_summary_comment(all_issues, base_url, auth, headers)