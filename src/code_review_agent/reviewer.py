import demjson3
from typing import Dict, List
from pydantic import ValidationError
from .models import ReviewResult, IssueType
from .llm_client import get_client

def run_review(
    changed_files_to_review: list,
    full_context_content: Dict[str, str],
    review_rules: List[str],
    llm_config: dict,
    focus_areas: List[IssueType]
) -> Dict[str, ReviewResult]:
    
    client = get_client(llm_config)
    model = llm_config.get('models', {}).get('reviewer', 'google/gemini-pro-1.5')

    focus_prompt_part = "Your primary focus for this review should be on the following areas: "
    focus_prompt_part += ", ".join(focus_areas) + "."
    if "Security" in focus_areas:
        focus_prompt_part += " Pay extra special attention to any potential security vulnerabilities like injections, XSS, or data leaks."
    if "Performance" in focus_areas:
        focus_prompt_part += " Look for inefficient algorithms, unnecessary database calls, or memory-intensive operations."

    system_prompt = f"""
    You are a meticulous and constructive senior software developer performing a code review.
    Your task is to analyze the provided code changes and identify potential issues.
    Your feedback must be actionable and precise.

    **{focus_prompt_part}**

    **Key Instructions:**
    1.  Focus your review ONLY on the files that were explicitly changed in the commit.
    2.  Use the full context of all provided files to understand dependencies and side effects.
    3.  If you find no issues in a file, you MUST return an empty list of issues.
    4.  If a fix is simple and obvious, provide a direct code suggestion in the `suggestion` field.
    5.  Adhere to the following custom project rules: {' '.join(review_rules)}

    **CRITICAL OUTPUT FORMATTING RULE:**
    Your entire response MUST be a single, valid JSON array of objects. Each object must have keys: "line_number", "issue_type", "comment", and an optional "suggestion".
    Do not add any other text, explanations, or markdown formatting. Your response must start with `[` and end with `]`.
    """

    review_results = {}
    context_str = "\n".join([f"--- START OF FILE: {path} ---\n{content}\n--- END OF FILE: {path} ---" for path, content in full_context_content.items()])

    for file_path in changed_files_to_review:
        print(f"🤖 Reviewing file: {file_path}")
        user_prompt = f"""
        Please review the file `{file_path}` based on the full context.
        Return your findings as a raw JSON array string.

        **Full Context of all Relevant Files:**
        ```
        {context_str}
        ```
        """
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ]
            )
            raw_response_text = response.choices[0].message.content.strip()

            try:
                json_str = raw_response_text
                if json_str.startswith("```json"):
                    json_str = json_str.split("```json\n", 1)[1].rsplit("\n```", 1)
                elif json_str.startswith("```"):
                    json_str = json_str.strip("` \n")
                
                if not json_str:
                    parsed_json = []
                else:
                    parsed_json = demjson3.decode(json_str)
                
                validated_result = ReviewResult(issues=parsed_json)
                review_results[file_path] = validated_result
            except (demjson3.JSONDecodeError, ValidationError, IndexError) as e:
                print(f"⚠️ Failed to parse or validate LLM response for {file_path}. Response was: '{raw_response_text}'. Error: {e}")
                review_results[file_path] = ReviewResult(issues=[])

        except Exception as e:
            print(f"\n⚠️ Critical error during LLM call for {file_path}: {e}")
            review_results[file_path] = ReviewResult(issues=[])

    return review_results