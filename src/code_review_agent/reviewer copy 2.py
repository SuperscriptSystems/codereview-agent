import json
from typing import Dict, List
from pydantic import ValidationError
from .models import ReviewResult, IssueType
from .llm_client import get_client

def _normalize_issue(raw_issue: dict) -> dict:
    """
    Takes a raw dictionary from the LLM and transforms it into a clean,
    Pydantic-compatible dictionary.
    """
    normalized = {}
    

    line_val = raw_issue.get('line_number') or raw_issue.get('line') or raw_issue.get('lineNumber', 0)
    try:
        normalized['line_number'] = int(line_val)
    except (ValueError, TypeError):
        normalized['line_number'] = 0

    comment_val = raw_issue.get('comment') or raw_issue.get('message') or raw_issue.get('description', '')
    normalized['comment'] = str(comment_val)

    issue_type_val = raw_issue.get('issue_type') or raw_issue.get('type')
    if issue_type_val and issue_type_val in IssueType.__args__:
        normalized['issue_type'] = issue_type_val
    else:
        found = False
        for issue_type_candidate in IssueType.__args__:
            if normalized['comment'].lower().startswith(issue_type_candidate.lower() + ":"):
                normalized['issue_type'] = issue_type_candidate
                normalized['comment'] = normalized['comment'][len(issue_type_candidate)+1:].strip()
                found = True
                break
        if not found:
            normalized['issue_type'] = 'Other'
    normalized['suggestion'] = raw_issue.get('suggestion')
    
    return normalized

def run_review(
    changed_files_to_review: List[str],
    final_context_content: Dict[str, str],
    diff_text: str,
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
    Your task is to analyze a file holistically and then focus your comments ONLY on the specific lines that were changed in a git diff.

    **CRITICAL FOCUS RULE:**
    **{focus_prompt_part}**
    **You are strictly forbidden from reporting any issue types that are not in this list. If you find issues of other types, you MUST ignore them completely and return an empty list. DO NOT use the 'Other' category as a fallback.**

    **Your Review Workflow:**
    1.  **Understand the File Context:** First, read the **full content of the file** being reviewed to understand its purpose, structure, and overall logic.
    2.  **Analyze the Changes:** Next, look at the **full git diff** to see exactly which lines in the file were added or modified.
    3.  **Formulate Comments:** Based on your holistic understanding from step 1, provide feedback **ONLY on the changed lines** from step 2. Your comments must be relevant to the changes.

    **CRITICAL RULES:**
    - DO NOT comment on existing code that was not part of the diff.
    - If you find no issues in the changed lines, you MUST return an empty list of issues.
    - If a fix is simple, provide a direct code suggestion in the `suggestion` field.
    - Adhere to the following custom project rules: {' '.join(review_rules)}
    
    **CRITICAL OUTPUT FORMATTING RULE:**
    Your entire response MUST be a single, valid JSON array of objects. Do not add any other text, explanations, or markdown formatting. Your response must start with `[` and end with `]`.

    **Before outputting the JSON, internally validate it to ensure it is perfectly formed. Pay special attention to escaping special characters like quotes (") and backslashes (\) within string values.
    """

    review_results = {}
    
    other_files_context = "\n".join([
        f"--- START FILE: {path} ---\n{content}\n--- END FILE: {path} ---" 
        for path, content in final_context_content.items() 
        if path not in changed_files_to_review
    ])

    for file_path in changed_files_to_review:
        print(f"🤖 Reviewing file: {file_path}")
        full_file_content = final_context_content.get(file_path, "File content not available.")

        user_prompt = f"""
        Please review the file `{file_path}` according to your workflow instructions.
        **1. Full Content of `{file_path}` (for primary analysis):**
        ```
        {full_file_content}
        ```
        **2. Full Git Diff of all changes in this PR (use this to identify changed lines in the file above):**
        ```diff
        {diff_text}
        ```
        **3. Full content of other relevant files (for additional context):**
        ```        {other_files_context}
        ```
        Return your findings as a raw JSON array string, commenting ONLY on the changed lines in `{file_path}`.
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
                start_index = raw_response_text.find('[')
                end_index = raw_response_text.rfind(']')

                if start_index != -1 and end_index != -1 and end_index > start_index:
                    json_str_cleaned = raw_response_text[start_index : end_index + 1]
                    parsed_json = json.loads(json_str_cleaned, strict=False)
                    
                    normalized_issues = [_normalize_issue(issue) for issue in parsed_json]
                    validated_result = ReviewResult(issues=normalized_issues)
                    review_results[file_path] = validated_result
                else:
                    raise json.JSONDecodeError("Could not find JSON array brackets `[]` in the response.")

            except (json.JSONDecodeError, ValidationError) as e:
                print(f"⚠️ Failed to parse or validate LLM response for {file_path}. Response was: '{raw_response_text}'. Error: {e}")
                review_results[file_path] = ReviewResult(issues=[])

        except Exception as e:
            print(f"\n⚠️ Critical error during LLM call for {file_path}: {e}")
            review_results[file_path] = ReviewResult(issues=[])

    return review_results