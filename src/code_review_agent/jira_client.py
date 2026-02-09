import os
import re
import logging
import requests
from requests.auth import HTTPBasicAuth

from .models import MergeSummary

logger = logging.getLogger(__name__)

def find_task_id(text: str) -> str | None:
    """Finds a Jira-like task ID (e.g., ABC-123) in a string."""
    if not text:
        return None
    match = re.search(r'(?<![A-Z\d-])([A-Z][A-Z0-9]{1,9}-\d+)', text, re.IGNORECASE)
    return match.group(1).upper() if match else None

def _auth_headers():
    email = os.environ["JIRA_USER_EMAIL"]
    token = os.environ["JIRA_API_TOKEN"]
    return HTTPBasicAuth(email, token), {"Accept": "application/json"}

def project_keys() -> set[str]:
    try:
        jira_url = os.environ["JIRA_URL"].rstrip("/")
        auth, headers = _auth_headers()
        resp = requests.get(f"{jira_url}/rest/api/3/project/search", headers=headers, auth=auth, timeout=10)
        if resp.status_code == 401:
            logger.warning("Jira auth failed while listing projects.")
            return set()
        resp.raise_for_status()
        data = resp.json()
        return {p.get("key") for p in data.get("values", []) if p.get("key")}
    except Exception as e:
        logger.debug(f"Could not fetch project keys: {e}")
        return set()

def get_task_details(task_id: str) -> dict | None:
    logger.info(f"🔎 Fetching details for Jira task: {task_id} using direct requests...")
    try:
        jira_url = os.environ["JIRA_URL"].rstrip("/")
        auth, headers = _auth_headers()
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
        return None
    except KeyError as e:
        logger.warning(f"Jira configuration missing ({e}), cannot fetch ticket details.")
        return None
    except Exception as e:
        logger.error(f"Failed to connect to Jira: {e}")
        return None

def _extract_text_from_adf(body):
    """
    Extract plain text from Atlassian Document Format (very simplified).
    """
    if isinstance(body, str):
        return body
    if isinstance(body, dict):
        parts = []
        for block in body.get("content", []):
            for item in block.get("content", []):
                txt = item.get("text")
                if txt:
                    parts.append(txt)
        return "\n".join(parts)
    return ""

def _current_account_id() -> str | None:
    try:
        jira_url = os.environ["JIRA_URL"].rstrip("/")
        auth, headers = _auth_headers()
        r = requests.get(f"{jira_url}/rest/api/3/myself", headers=headers, auth=auth, timeout=10)
        if r.status_code == 200:
            return r.json().get("accountId")
    except Exception:
        pass
    return None

def _remove_previous_ai_comments(jira_url: str, task_id: str, markers: list[str], account_id: str | None):
    auth, headers = _auth_headers()
    try:
        resp = requests.get(
            f"{jira_url}/rest/api/3/issue/{task_id}/comment?maxResults=100",
            headers=headers, auth=auth, timeout=20
        )
        if resp.status_code != 200:
            logger.debug(f"[AI Comment] List comments status={resp.status_code}")
            return
        data = resp.json()
        removed = 0

        def _norm(txt: str) -> str:
            return txt.replace("*", "").strip()

        norm_markers = {_norm(m) for m in markers}

        for c in data.get("comments", []):
            cid = c.get("id")
            author_id = c.get("author", {}).get("accountId")
            body_text = _extract_text_from_adf(c.get("body"))
            body_norm = _norm(body_text)
            if any(nm in body_norm for nm in norm_markers) and (account_id is None or author_id == account_id):
                try:
                    d = requests.delete(
                        f"{jira_url}/rest/api/3/issue/{task_id}/comment/{cid}",
                        headers=headers, auth=auth, timeout=15
                    )
                    if d.status_code in (204, 200):
                        removed += 1
                    else:
                        logger.debug(f"[AI Comment] Delete {cid} status={d.status_code}")
                except Exception as e:
                    logger.debug(f"[AI Comment] Delete {cid} exception: {e}")
        if removed:
            logger.info(f"Removed {removed} previous AI comment(s).")
    except Exception as e:
        logger.debug(f"[AI Comment] Cleanup failed: {e}")


def add_comment(task_id: str, comment: str | dict):
    """
    Adds (replaces) AI assessment comment with bold marker.
    Supports str (Jira Wiki Markup) via v2 API.
    Supports dict (ADF) via v3 API.
    """
    logger.info(f"Adding comment to Jira task {task_id}...")
    try:
        jira_url = os.environ["JIRA_URL"].rstrip("/")
        auth, headers = _auth_headers()

        # Primary (bold) marker
        primary_marker_raw = os.getenv("JIRA_AI_COMMENT_TAG", "*🤖 AI Assessment Complete*")
        primary_marker_clean = primary_marker_raw.replace("*", "")
        
        legacy_markers = [
            "🤖 AI Assessment Complete",
            "🤖 AI Assessment"
        ]
        all_markers = [primary_marker_raw] + [m for m in legacy_markers if m != primary_marker_raw]

        account_id = _current_account_id()
        _remove_previous_ai_comments(jira_url, task_id, all_markers, account_id)

        target_ver = "2"
        payload_body = comment
        
        if isinstance(comment, str):
            # Wiki Markup -> v2
            first_line = comment.strip().splitlines()[0] if comment.strip() else ""
            if not any(first_line.replace("*", "").startswith(m.replace("*", "")) for m in all_markers):
                payload_body = f"{primary_marker_raw}\n\n{comment}"
            target_ver = "2"
            
        elif isinstance(comment, dict):
            # ADF -> v3
            # Ensure marker is present
            content = comment.get("content", [])
            has_marker = False
            
            # Basic check: first text node text starts with marker
            if content and content[0].get("content"):
                first_nodes = content[0]["content"]
                if first_nodes and first_nodes[0].get("text", "").strip().startswith(primary_marker_clean):
                    has_marker = True

            if not has_marker:
                marker_node = {
                    "type": "paragraph",
                    "content": [
                        {
                            "type": "text", 
                            "text": primary_marker_clean, 
                            "marks": [{"type": "strong"}]
                        }
                    ]
                }
                content.insert(0, marker_node)
                comment["content"] = content
            
            payload_body = comment
            target_ver = "3"

        payload = {"body": payload_body}
        
        api_url = f"{jira_url}/rest/api/{target_ver}/issue/{task_id}/comment"
        resp = requests.post(api_url, json=payload, headers=headers, auth=auth, timeout=20)
        
        if resp.status_code == 404:
            logger.warning(f"[Jira] 404 on comment POST v{target_ver} (issue not visible).")
            return
        if resp.status_code == 403:
            logger.warning(f"[Jira] 403 on comment POST v{target_ver} (no Add Comments permission).")
            return
        if resp.status_code not in (201, 200):
            logger.error(f"[Jira] comment POST v{target_ver} status={resp.status_code} body={resp.text[:160]}")
            return
            
        logger.info(f"✅ Comment added via v{target_ver} (replaced previous).")
        
    except Exception as e:
        logger.error(f"Failed to add comment to Jira task {task_id}. Error: {e}")    


def add_assessment_comment(task_id: str, summary: MergeSummary):
    """
    Formats the structured summary into ADF (Atlassian Document Format) and calls add_comment.
    """
    logger.info(f"Formatting assessment summary for Jira task {task_id} (ADF)...")

    content_nodes = []

    # Commit summary
    content_nodes.append({
        "type": "paragraph",
        "content": [{
            "type": "text",
            "text": summary.commit_summary,
            "marks": [{"type": "strong"}]
        }]
    })

    # Relevance Score
    content_nodes.append({
        "type": "heading",
        "attrs": {"level": 3},
        "content": [{"type": "text", "text": f"Task Relevance Score: {summary.relevance_score}%"}]
    })

    # Justification
    content_nodes.append({
        "type": "paragraph",
        "content": [{
            "type": "text", 
            "text": summary.relevance_justification,
            "marks": [{"type": "em"}]
        }]
    })
    
    def _create_list_item(prefix_text, item_text, status_icon=""):
        return {
            "type": "listItem",
            "content": [{
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": f"{status_icon} {prefix_text}", "marks": [{"type": "strong"}]},
                    {"type": "text", "text": item_text, "marks": [{"type": "code"}]}
                ]
            }]
        }

    # Database Changes
    if summary.db_tables_created or summary.db_tables_modified:
        content_nodes.append({
            "type": "heading",
            "attrs": {"level": 3},
            "content": [{"type": "text", "text": "Database Changes:"}]
        })
        list_items = []
        for table in summary.db_tables_created:
            list_items.append(_create_list_item("Created Table: ", table, "✅"))
        for table in summary.db_tables_modified:
            list_items.append(_create_list_item("Modified Table: ", table, "ℹ️"))
        content_nodes.append({"type": "bulletList", "content": list_items})

    # API Changes
    if summary.api_endpoints_added or summary.api_endpoints_modified:
        content_nodes.append({
            "type": "heading",
            "attrs": {"level": 3},
            "content": [{"type": "text", "text": "API Endpoint Changes:"}]
        })
        list_items = []
        for endpoint in summary.api_endpoints_added:
            list_items.append(_create_list_item("Added: ", endpoint, "✅"))
        for endpoint in summary.api_endpoints_modified:
            list_items.append(_create_list_item("Modified: ", endpoint, "ℹ️"))
        content_nodes.append({"type": "bulletList", "content": list_items})

    adf_body = {
        "version": 1,
        "type": "doc",
        "content": content_nodes
    }
            
    add_comment(task_id, adf_body)