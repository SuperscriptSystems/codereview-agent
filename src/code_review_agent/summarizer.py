import json
import logging
from pydantic import ValidationError
from .models import MergeSummary
from .llm_client import get_client

logger = logging.getLogger(__name__)

def summarize_changes_for_jira(
    jira_details: str,
    commit_messages: str,
    diff_text: str,
    llm_config: dict,
) -> MergeSummary | None:
    
    client = get_client(llm_config)
    model = llm_config.get('models', {}).get('summarizer', 'google/gemini-flash-1.5')

    system_prompt = """
    You are an expert AI software analyst. Your task is to analyze a git diff and commit messages to produce a structured summary for a Jira ticket.

    **Analysis Instructions:**
    1.  **Relevance:** Read the Jira task details and the code changes. Rate from 0-100% how relevant the changes are to the task.
    2.  **Database Changes:** Look for changes in database migration files, entity configurations, or DbContext files. Identify created or modified table names.
    3.  **API Changes:** Look for changes in Controller files or route definitions. Identify added or modified API endpoints (e.g., "GET /api/users", "POST /api/products/{id}").
    4.  **Commit Summary:** Read all commit messages and produce a single, concise, high-level summary of the work done.

    **CRITICAL OUTPUT FORMATTING RULE:**
    Your entire response MUST be a single, valid JSON object that adheres to the `MergeSummary` schema. Do not add any other text.
    """

    user_prompt = f"""
    Please analyze the following data and provide a structured summary.

    {jira_details}

    **Commit Messages:**
    ```
    {commit_messages}
    ```

    **Full Git Diff:**
    ```diff
    {diff_text}
    ```

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
            return None
            
    except Exception as e:
        logger.error(f"Critical error during summary LLM call: {e}", exc_info=True)
        return None