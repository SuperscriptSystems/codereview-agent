from .models import ContextRequirements
from .llm_client import get_client

def determine_context(
    diff: str,
    commit_messages: str,
    changed_files_content: dict,
    file_structure: str,
    current_context_files: list,
    llm_config: dict,
) -> ContextRequirements:
    
    client = get_client(llm_config.get("provider", "openai"))
    model = llm_config.get("model_context", "gpt-4o")

    system_prompt = """
    You are an expert AI software architect. Your sole task is to determine the MINIMAL SUFFICIENT CONTEXT for a comprehensive code review.
    You will be given a git diff, commit messages, the content of changed files, a list of files already in context, and the project's full file structure.
    Your goal is to identify ONLY the essential additional files needed to understand the full impact of the changes.

    RULES:
    1.  Analyze the provided diff to identify all external dependencies: functions or classes called, interfaces implemented, base classes inherited, etc.
    2.  Use the file structure to locate the definitions of these dependencies.
    3.  Return a list of these file paths. Only include files that are NOT already in the current context.
    4.  If the provided context ALREADY seems complete and sufficient, you MUST return an empty list for `required_additional_files` and set `is_sufficient` to true.
    5.  Be ruthlessly minimal and precise. Do not request unrelated files. Your primary goal is to avoid context bloating.
    6.  NEVER request binary, generated, or vendor files (e.g., .dll, .min.js, node_modules, .lock).
    """

    changed_files_summary = "\n".join([f"- `{path}`" for path in changed_files_content.keys()])
    context_files_summary = "\n".join([f"- `{path}`" for path in current_context_files])
    
    user_prompt = f"""
    Here is the data for analysis:

    **Commit Messages:**
    ```
    {commit_messages}
    ```
    
    **Initially Changed Files:**
    ```
    {changed_files_summary}
    ```

    **Git Diff for these changes:**
    ```diff
    {diff}
    ```
    
    **Files Already in Context:**
    ```    {context_files_summary}
    ```

    **Full Project File Structure:**
    ```
    {file_structure}
    ```

    Based on this, what other files are absolutely necessary for a complete review?
    """
    
    try:
        response = client.chat.completions.create(
            model=model,
            response_model=ContextRequirements,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_retries=1,
        )
        return response
    except Exception as e:
        print(f"\n⚠️ Error in Context Builder agent: {e}")
        return ContextRequirements(required_additional_files=[], is_sufficient=True, reasoning="Error occurred, aborting context search.")