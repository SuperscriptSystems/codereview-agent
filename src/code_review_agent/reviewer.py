from typing import Dict, List
from .models import ReviewResult
from .llm_client import get_client

def run_review(
    changed_files_to_review: list,
    full_context_content: Dict[str, str], # {path: content}
    review_rules: List[str],
    llm_config: dict,
) -> Dict[str, ReviewResult]:
    
    client = get_client(llm_config.get("provider", "openai"))
    model = llm_config.get("model_review", "gpt-4o")
    
    system_prompt = f"""
    You are a meticulous and constructive senior software developer performing a code review.
    Your task is to analyze the provided code changes and identify potential issues.
    Your feedback must be actionable and precise.

    **Key Instructions:**
    1.  Focus your review ONLY on the files that were explicitly changed in the commit.
    2.  Use the full context of all provided files to understand dependencies and side effects.
    3.  If you find no issues in a file, you MUST return an empty list of issues. It is perfectly acceptable to find no problems. This is a critical instruction to reduce hallucinations.
    4.  If a fix is simple and obvious, provide a direct code suggestion in the `suggestion` field.
    5.  Adhere to the following custom project rules: {' '.join(review_rules)}
    """

    review_results = {}
    context_str = "\n".join([f"--- START OF FILE: {path} ---\n{content}\n--- END OF FILE: {path} ---" for path, content in full_context_content.items()])

    for file_path in changed_files_to_review:
        print(f"🤖 Reviewing file: {file_path}")
        user_prompt = f"""
        Please review the file `{file_path}`.

        **Full Context of all Relevant Files:**
        ```
        {context_str}
        ```

        Focus your review on `{file_path}` and provide feedback based on the full context.
        """
        try:
            response = client.chat.completions.create(
                model=model,
                response_model=ReviewResult,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                max_retries=1,
            )
            review_results[file_path] = response
        except Exception as e:
            print(f"\n⚠️ Error reviewing file {file_path}: {e}")
            review_results[file_path] = ReviewResult(issues=[])

    return review_results