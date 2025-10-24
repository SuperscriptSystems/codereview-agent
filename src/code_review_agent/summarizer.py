import json
import logging
from pydantic import ValidationError
from .models import MergeSummary
from .llm_client import get_client

logger = logging.getLogger(__name__)

def summarize_changes_for_jira(
    jira_details: str,
    commit_messages: str,
    diff_summary: dict,
    llm_config: dict,
) -> MergeSummary | None:
    
    client = get_client(llm_config)
    model = llm_config.get('models', {}).get('summarizer', 'gpt-5-mini')

    system_prompt = """
    You are an expert AI software analyst. Your task is to analyze metadata about code changes and produce a high-level summary for a Jira ticket.
    
    CRITICAL OUTPUT FORMATTING RULE:
    Your entire response MUST be a single, valid JSON object that adheres to the `MergeSummary` schema.
    """
    
    diff_summary_text = json.dumps(diff_summary, indent=2)

    user_prompt = f"""
    Please analyze the following data and provide a structured summary.

    **Jira Task Details:**
    ```
    {jira_details}
    ```

    **Commit Messages:**
    ```
    {commit_messages}
    ```

    **Structured Summary of Code Changes (file paths, insertions, deletions):**
    ```json
    {diff_summary_text}
    ```

    Based on all this metadata, provide your assessment.
    Return your findings as a raw JSON object string.
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
        raw_response_text = response.choices[0].message.content.strip()
        
        try:
            parsed_json = json.loads(raw_response_text, strict=False)
            return MergeSummary(**parsed_json)
        except (json.JSONDecodeError, ValidationError) as e:
            logger.warning(f"Failed to parse summary response. Error: {e}")
            logger.debug(f"Problematic response was: '{raw_response_text}'")
            return None
            
    except Exception as e:
        logger.error(f"Critical error during summary LLM call: {e}", exc_info=True)
        return None