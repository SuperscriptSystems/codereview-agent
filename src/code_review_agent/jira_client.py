import os
import re
import logging
import requests
from requests.auth import HTTPBasicAuth

logger = logging.getLogger(__name__)

def find_task_id(text: str) -> str | None:
    """Finds a Jira-like task ID (e.g., ABC-123) in a string."""
    if not text:
        return None
    match = re.search(r'(?<![A-Z\d-])([A-Z][A-Z0-9]{1,9}-\d+)', text, re.IGNORECASE)
    return match.group(1).upper() if match else None

def get_task_details(task_id: str) -> dict | None:
    """
    Fetches task details (tries API v2 then v3).
    """
    logger.info(f"🔎 Fetching details for Jira task: {task_id} using direct requests...")
    try:
        jira_url = os.environ["JIRA_URL"].rstrip("/")
        email = os.environ["JIRA_USER_EMAIL"]
        token = os.environ["JIRA_API_TOKEN"]

        auth = HTTPBasicAuth(email, token)
        headers = {"Accept": "application/json"}
        for api_ver in ("2", "3"):
            api_url = f"{jira_url}/rest/api/{api_ver}/issue/{task_id.upper()}"
            resp = requests.get(api_url, headers=headers, auth=auth)
            if resp.status_code == 404:
                logger.warning(f"[Jira] 404 for {task_id} at /api/{api_ver}. (Wrong key? No permission? Deleted?)")
                continue
            try:
                resp.raise_for_status()
            except Exception as e:
                logger.error(f"[Jira] Error {e} (status={resp.status_code}) body={resp.text[:300]}")
                continue

            data = resp.json()
            description = "No description found."
            if data.get('fields', {}).get('description'):
                try:
                    desc_field = data['fields']['description']
                    # Handle both old plain text and Atlassian Document Format
                    if isinstance(desc_field, dict) and 'content' in desc_field:
                        text_parts = []
                        for block in desc_field.get('content', []):
                            for p in block.get('content', []):
                                if p.get('type') == 'text' and p.get('text'):
                                    text_parts.append(p['text'])
                        if text_parts:
                            description = "\n".join(text_parts)
                    else:
                        description = str(desc_field)
                except Exception:
                    description = str(data['fields']['description'])
            return {
                "summary": data.get('fields', {}).get('summary', 'N/A'),
                "description": description
            }
    except KeyError as e:
        logger.warning(f"Jira configuration missing ({e}), cannot fetch ticket details.")
        return None
    except Exception as e:
        logger.error(f"Failed to connect to Jira: {e}")
        return None


def add_comment(task_id: str, comment: str):
    """Adds a comment to a Jira issue using a direct `requests` call."""
    logger.info(f"Adding comment to Jira task {task_id}...")
    try:
        jira_url = os.environ["JIRA_URL"]
        email = os.environ["JIRA_USER_EMAIL"]
        token = os.environ["JIRA_API_TOKEN"]

        api_url = f"{jira_url}/rest/api/2/issue/{task_id}/comment"
        auth = HTTPBasicAuth(email, token)
        headers = {
          "Accept": "application/json",
          "Content-Type": "application/json"
        }
        payload = {"body": comment}

        response = requests.request(
           "POST",
           api_url,
           json=payload,
           headers=headers,
           auth=auth
        )
        response.raise_for_status()
        logger.info("✅ Successfully added comment to Jira.")
    except Exception as e:
        logger.error(f"Failed to add comment to Jira task {task_id}. Error: {e}")    