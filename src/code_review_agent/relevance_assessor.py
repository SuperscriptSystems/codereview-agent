import json
import logging
from pydantic import ValidationError
from .models import TaskRelevance
from .llm_client import get_client

logger = logging.getLogger(__name__)

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
    You are an expert project manager AI. Your task is to assess how relevant a code change is to its associated Jira task.
    You MUST provide a score from 0 to 100 and a brief justification.

    CRITICAL OUTPUT FORMATTING RULE:
    Your entire response MUST be a single, valid JSON object with two keys: "score" (integer, 0-100) and "justification" (string).
    Do not add any other text or explanations.
    """

    user_prompt = f"""
    Please assess the relevance of the following code changes to the Jira task.

    {jira_details}

    **Commit Messages:**
    ```
    {commit_messages}
    ```

    **Summary of Code Changes (Git Diff):**
    ```diff
    {diff_text}
    ```

    **AI Code Review Summary:**
    ```
    {review_summary}
    ```

    Based on all this information, rate from 0 to 100% how related the code change is to the Jira task.
    Return your assessment as a raw JSON object string.
    """
    
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]
        )
        # Robust extraction (choices may be list; element may have message.content or text)
        choices = getattr(response, "choices", None)
        if not choices:
            logger.error(f"LLM response has no 'choices': {response}")
            return None

        first = choices[0]
        content = None
        # pydantic / attr object
        if hasattr(first, "message") and getattr(first.message, "content", None):
            content = first.message.content
        # some providers: first.text
        elif hasattr(first, "text"):
            content = first.text
        # dict style
        elif isinstance(first, dict):
            content = (
                first.get("message", {}).get("content") or
                first.get("text")
            )

        if not content:
            logger.error(f"Cannot extract content from first choice: {first}")
            return None

        raw_response_text = content.strip()
        # Optional debug
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(f"Raw relevance LLM response: {raw_response_text[:500]}")

        try:
            parsed_json = json.loads(raw_response_text, strict=False)
            return TaskRelevance(**parsed_json)
        except (json.JSONDecodeError, ValidationError) as e:
            logger.warning(f"Failed to parse relevance assessment response. Error: {e}")
            return None
    except Exception as e:
        logger.error(f"Error during LLM relevance assessment: {e}")
        return None