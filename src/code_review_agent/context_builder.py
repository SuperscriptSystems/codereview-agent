from typing import List, Optional
from pydantic import BaseModel, Field
from .reviewer import get_client

class ContextRequirements(BaseModel):

    required_additional_files: List[str] = Field(
        ..., description="A list of additional file paths needed for a full review."
    )
    is_sufficient: bool = Field(
        ..., description="Set to true if the current context is sufficient and no more files are needed."
    )
    reasoning: str = Field(
        ..., description="A brief explanation of why the additional files are needed or why the context is sufficient."
    )

def find_required_context_files(
    changed_files_map: dict,
    commit_messages: str,
    full_file_structure: str,
    current_context_files: List[str]
) -> ContextRequirements:

    print("🤖 Asking Context Builder Agent what other files are needed...")

    changed_files_summary = "\n".join(
        f"- `{path}` (diff provided)" for path in changed_files_map.keys()
    )
    context_files_summary = "\n".join(
        f"- `{path}`" for path in current_context_files if path not in changed_files_map
    )

    system_prompt = """
    You are an expert AI architect. Your task is to determine the MINIMAL SUFFICIENT CONTEXT for a code review.
    You will be given a git diff, commit messages, and the project's file structure.
    Your goal is to identify ONLY the essential additional files needed to understand the full impact of the changes.
    
    RULES:
    1.  Analyze the provided diff and identify dependencies: called functions, inherited classes, used interfaces, etc.
    2.  Look at the file structure and find the definitions of these dependencies.
    3.  Return a list of these file paths in `required_additional_files`.
    4.  If the provided context ALREADY seems complete, return an empty list and set `is_sufficient` to true.
    5.  DO NOT request files that are not directly related to the changes. Be minimal and precise.
    6.  DO NOT request binary, generated, or vendor files (e.g., .dll, .min.js, node_modules, .sln).
    """

    user_prompt = f"""
    Here is the data for the code review:

    **Commit Messages:**
    ```
    {commit_messages}
    ```

    **Changed Files (Diffs are provided separately):**
    {changed_files_summary}

    **Current Context Files (Content will be provided):**
    {context_files_summary if context_files_summary else "None"}

    **Full Project File Structure:**
    ```
    {full_file_structure}
    ```

    Based on this, what other files are absolutely necessary for a complete review?
    """

    client = get_client()
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            response_model=ContextRequirements,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        print(f"🧠 Context Agent reasoning: {response.reasoning}")
        return response
    except Exception as e:
        print(f"❌ Error in Context Builder agent: {e}")
        return ContextRequirements(required_additional_files=[], is_sufficient=True, reasoning="Error occurred.")