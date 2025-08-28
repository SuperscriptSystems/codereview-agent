import json
import logging
from pydantic import ValidationError
from .models import TaskRelevance
from .llm_client import get_client
import re

logger = logging.getLogger(__name__)

def _extract_first_json_object(text: str) -> str | None:
    # Remove markdown code fences
    fenced = re.sub(r"```(?:json)?", "", text, flags=re.IGNORECASE).replace("```", "")
    # Try direct load
    try:
        obj = json.loads(fenced)
        if isinstance(obj, dict):
            return json.dumps(obj)
    except Exception:
        pass
    # Regex scan for first top-level { } block
    stack = 0
    start = None
    for i, ch in enumerate(fenced):
        if ch == '{':
            if stack == 0:
                start = i
            stack += 1
        elif ch == '}':
            if stack > 0:
                stack -= 1
                if stack == 0 and start is not None:
                    candidate = fenced[start:i+1].strip()
                    try:
                        json.loads(candidate)
                        return candidate
                    except Exception:
                        continue
    return None


def assess_relevance(
    jira_details: str,
    commit_messages: str,
    diff_text: str,
    review_summary: str,
    llm_config: dict,
) -> TaskRelevance | None:
    client = get_client(llm_config)
    model = llm_config.get('models', {}).get('assessor', 'google/gemini-flash-1.5')

    system_prompt = """
    You are an expert project manager AI. Output ONLY raw JSON (no code fences, no prose).
    JSON schema: {"score": <int 0-100>, "justification": "<short sentence>"}.
    """

    user_prompt = f"""Evaluate relevance 0..100.

    Jira Task:
    {jira_details or "No Jira description available."}

    Commit Messages:
    {commit_messages}

    Diff:
    {diff_text[:10000]}

    Review Summary:
    {review_summary}

    Return ONLY JSON object. No explanations.
    """

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0
        )
        choices = getattr(response, "choices", None)
        if not choices:
            logger.error(f"LLM response has no 'choices': {response}")
            return None
        first = choices[0]
        content = None
        if hasattr(first, "message") and getattr(first.message, "content", None):
            content = first.message.content
        elif hasattr(first, "text"):
            content = first.text
        elif isinstance(first, dict):
            content = first.get("message", {}).get("content") or first.get("text")
        if not content:
            logger.error(f"Cannot extract content from first choice: {first}")
            return None
        raw = content.strip()
        logger.debug(f"Raw relevance LLM response: {raw[:800]}")

        json_blob = _extract_first_json_object(raw)
        if not json_blob:
            logger.warning("Could not isolate JSON object in relevance response.")
            return None

        try:
            parsed = json.loads(json_blob)
            return TaskRelevance(**parsed)
        except (json.JSONDecodeError, ValidationError) as e:
            logger.warning(f"Failed to parse relevance JSON after extraction: {e}")
            return None
    except Exception as e:
        logger.error(f"Error during LLM relevance assessment: {e}")
        return None