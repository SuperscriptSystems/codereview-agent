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
    Fetches task details using a direct, raw `requests` call to mimic `curl`.
    """
    logger.info(f"🔎 Fetching details for Jira task: {task_id} using direct requests...")
    try:
        
        jira_url = os.environ["JIRA_URL"]
        email = os.environ["JIRA_USER_EMAIL"]
        token = os.environ["JIRA_API_TOKEN"]

        api_url = f"{jira_url}/rest/api/2/issue/{task_id}"
        
        auth = HTTPBasicAuth(email, token)
        

        headers = {
          "Accept": "application/json"
        }

        response = requests.request(
           "GET",
           api_url,
           headers=headers,
           auth=auth
        )
        
        response.raise_for_status()
        
        data = response.json()
        
        description = "No description found."
        if data.get('fields', {}).get('description'):
            try:
                desc_content = data['fields']['description'].get('content', [])
                text_parts = [
                    p.get('content', [{}])[0].get('text', '') 
                    for block in desc_content if block.get('type') == 'paragraph'
                    for p in block.get('content', []) if p.get('type') == 'text'
                ]
                description = "\n".join(text_parts)
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