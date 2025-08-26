import os
import re
import logging
from jira import JIRA

logger = logging.getLogger(__name__)
_client = None

def _get_jira_client():
    """Initializes and returns the Jira client."""
    global _client
    if _client: return _client

    try:
        url = os.environ["JIRA_URL"]
        email = os.environ["JIRA_USER_EMAIL"]
        token = os.environ["JIRA_API_TOKEN"]
        
        _client = JIRA(server=url, basic_auth=(email, token))
        return _client
    except KeyError as e:
        logger.warning(f"Jira configuration missing ({e}), cannot fetch ticket details.")
        return None
    except Exception as e:
        logger.error(f"Failed to connect to Jira: {e}")
        return None

def find_task_id(text: str) -> str | None:
    """Finds a Jira-like task ID (e.g., ABC-123) in a string."""
    match = re.search(r'\b([A-Z]{2,4}-\d+)\b', text, re.IGNORECASE)
    return match.group(0).upper() if match else None

def get_task_details(task_id: str) -> dict | None:
    """Fetches the summary and description for a given Jira task ID."""
    client = _get_jira_client()
    if not client or not task_id:
        return None
    
    logger.info(f"🔎 Fetching details for Jira task: {task_id}")
    try:
        issue = client.issue(task_id)
        return {
            "summary": getattr(issue.fields, 'summary', 'N/A'),
            "description": getattr(issue.fields, 'description', 'N/A')
        }
    except Exception as e:
        logger.warning(f"Could not fetch details for Jira task {task_id}. Error: {e}")
        return None