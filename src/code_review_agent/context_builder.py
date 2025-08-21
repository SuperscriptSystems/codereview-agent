import json
import logging
from pydantic import ValidationError
from .models import ContextRequirements
from .llm_client import get_client

logger = logging.getLogger(__name__)

def determine_context(
    diff: str,
    commit_messages: str,
    changed_files_content: dict,
    full_context_content: dict,
    file_structure: str,
    current_context_files: list,
    llm_config: dict,
) -> ContextRequirements:
    
    client = get_client(llm_config)
    model = llm_config.get('models', {}).get('context_builder', 'google/gemini-pro-1.5')
    
    system_prompt = """
    You are an expert AI software architect. Your sole task is to determine the MINIMAL SUFFICIENT CONTEXT for a code review.
    Your goal is to identify ONLY the essential additional files needed.

    CRITICAL OUTPUT FORMATTING RULE:
    Your entire response MUST be a single, valid JSON object. Do not add any other text or explanations. Your response must start with `{` and end with `}`.
    The JSON object must have these keys: "required_additional_files" (list of strings), "is_sufficient" (boolean), and "reasoning" (string).
    """

    changed_files_summary = "\n".join([f"- `{path}`" for path in changed_files_content.keys()])
    context_files_summary = "\n".join([f"- `{path}`" for path in current_context_files])
    full_context_text = "\n".join([
    f"--- START FILE: {path} ---\n{content}\n--- END FILE: {path} ---"
    for path, content in full_context_content.items()
    ])

    user_prompt = f"""
    Analyze the following data and determine what other files are necessary for a complete review.

    **Commit Messages:**
    ```
    {commit_messages}
    ```
    
   **Initially Changed Files (Primary Focus):**
    ```
    {changed_files_summary}
    ```

    **Full Content of All Files Currently in Context:**
    ```
    {full_context_text}
    ```
    
    Git Diff:
    ```diff
    {diff}
    ```
    
    Files Already in Context:
    ```
    {context_files_summary}
    ```

    File Structure of Current Context:
    ```
    {file_structure}
    ```

    Return your findings as a raw JSON object string.
    """
    
    try:
        logger.debug(f"--- System Prompt for Context Builder ---\n{system_prompt}")
        logger.debug(f"--- User Prompt for Context Builder ---\n{user_prompt}")

        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        raw_response_text = response.choices[0].message.content.strip()
        logger.debug(f"Raw LLM response from Context Builder:\n{raw_response_text}")

        try:
            json_str = raw_response_text
            if json_str.startswith("```json"):
                json_str = json_str.split("```json\n", 1)[1].rsplit("\n```", 1)[0]
            elif json_str.startswith("```"):
                json_str = json_str.strip("` \n")
            
            parsed_json = json.loads(json_str, strict=False)
            validated_response = ContextRequirements(**parsed_json)
            return validated_response
        
        except (json.JSONDecodeError, ValidationError, IndexError) as e:
            logger.warning(f"Failed to parse/validate LLM response for context builder. Error: {e}")
            logger.debug(f"Problematic response was: '{raw_response_text}'")
            return ContextRequirements(required_additional_files=[], is_sufficient=True, reasoning="Failed to parse LLM response.")
    
    except Exception as e:
        logger.error(f"Error in Context Builder agent: {e}", exc_info=True)
        return ContextRequirements(required_additional_files=[], is_sufficient=True, reasoning="Error occurred during LLM call, aborting context search.")