import os
import io
import logging
from github import Github
from github import GithubException
from unidiff import PatchSet
from .models import CodeIssue
from collections import Counter

logger = logging.getLogger(__name__)

_client = None

def _get_github_client():
    """
    Initializes and returns the GitHub client. No user info is fetched here.
    """
    global _client
    if _client:
        return _client
            
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        logger.error("GITHUB_TOKEN environment variable is not set.")
        raise ValueError("GITHUB_TOKEN environment variable not set.")
    
    try:
        _client = Github(token)
        logger.info("✅ GitHub client initialized successfully.")
        return _client
    except Exception as e:
        logger.error(f"❌ CRITICAL: Failed to initialize GitHub client. Error: {e}", exc_info=True)
        raise ValueError("GitHub client initialization failed.")


def handle_pr_results(all_issues: list[CodeIssue], files_with_issues: dict, changed_files_map: dict):
    """
    Main entry point for GitHub. Cleans old comments, filters issues to only those on changed lines,
    then posts new issues or approves the PR.
    """
    try:
        client = _get_github_client()
        repo_name = os.environ["GITHUB_REPOSITORY"]
        pr_number = int(os.environ["GITHUB_PR_NUMBER"])
        
        repo = client.get_repo(repo_name)
        pr = repo.get_pull(pr_number)
        
        logger.info("   - Searching for and deleting old review comments...")

        logger.info("   - Filtering issues to only include comments on changed lines...")
        
        changed_lines_by_file = {}
        for file_path, diff_content in changed_files_map.items():
            try:
                patch = PatchSet(io.StringIO(diff_content))
                if patch:
                    changed_lines_by_file[file_path] = {
                        line.target_line_no for hunk in patch[0] for line in hunk if line.is_added
                    }
            except Exception as e:
                logger.warning(f"Could not parse diff for {file_path}: {e}")
        
        valid_comments_for_review = []
        valid_issues_found = 0
        latest_commit = pr.get_commits().reversed[0]

        for file_path, issues in files_with_issues.items():
            valid_lines = changed_lines_by_file.get(file_path, set())
            
            for issue in issues:
                if issue.line_number in valid_lines:
                    comment_body = f"**[{issue.issue_type}]**\n\n{issue.comment}"
                    if issue.suggestion:
                        comment_body += f"\n```suggestion\n{issue.suggestion}\n```"
                    
                    valid_comments_for_review.append({
                        "path": file_path,
                        "line": issue.line_number,
                        "body": comment_body
                    })
                    valid_issues_found += 1
                else:
                    logger.warning(f"   - Skipping comment for {file_path} on line {issue.line_number} because it's not in the diff.")

        if valid_issues_found == 0:
            logger.info("✅ All found issues were on unchanged lines or no issues were found. Approving PR.")
            pr.create_issue_comment("AI review completed. Looks good to me! 👍")
            pr.create_review(event="APPROVE")
            logger.info("✅ Successfully approved the Pull Request.")
        else:
            logger.info(f"   - Found {valid_issues_found} valid issue(s) on changed lines. Submitting a review...")
            
            summary_body = _generate_summary_comment(all_issues)
            
            pr.create_review(
                commit=latest_commit,
                body=summary_body,
                event="REQUEST_CHANGES",
                comments=valid_comments_for_review
            )
            logger.info("✅ Successfully submitted a review with change requests.")

    except GithubException as e:
        logger.error("❌ A GitHub API error occurred!")
        logger.error(f"   - Status: {e.status}")
        logger.error(f"   - Details: {e.data}")
        raise
    except Exception as e:
        logger.error(f"❌ An unexpected error occurred during the GitHub publishing process: {e}", exc_info=True)
        raise

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