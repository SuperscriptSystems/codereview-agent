import json
import ast
from typing import Dict, List, Any
from pydantic import ValidationError
from .models import ReviewResult, IssueType
from .llm_client import get_client

def robust_json_parser(json_string: str) -> Any:
    """
    Tries to parse a JSON-like string using multiple strategies.
    1. Try standard `json.loads`.
    2. If it fails, try less strict `ast.literal_eval`.
    """
    try:
        return json.loads(json_string, strict=False)
    except json.JSONDecodeError as e:
        print(f"Info: json.loads failed ({e}). Falling back to ast.literal_eval.")
        try:
            return ast.literal_eval(json_string)
        except (ValueError, SyntaxError) as ast_e:
            print(f"Info: ast.literal_eval also failed ({ast_e}).")
            raise e

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

    custom_rules_instruction = ""
    if review_rules:
        rules_text = "\n- ".join(review_rules)
        custom_rules_instruction = f"**Adhere to the following custom project rules:**\n- {rules_text}"

    system_prompt = f"""
    You are an expert AI code review assistant. Your sole function is to analyze code changes and output a clean, valid JSON array of issues.

    **--- YOUR TASK ---**
    Analyze the provided `git diff` within the context of the full files. Your goal is to identify issues ONLY in the changed lines of code.

    **--- YOUR WORKFLOW ---**
    1.  **Holistic Understanding:** First, review the full content of all provided files to understand the complete context.
    2.  **Focus on Changes:** Second, analyze the `git diff` to identify the specific lines that were added or modified.
    3.  **Formulate Comments:** Finally, formulate your feedback. Your comments MUST apply ONLY to the changed lines identified in the diff.

    **--- CRITICAL RULES ---**
    1.  **FOCUS:** You are strictly forbidden from reporting any issue types that are not in this list: **{', '.join(focus_areas)}**. If you find issues of other types, you MUST ignore them.
    2.  **SCOPE:** DO NOT comment on existing, unchanged code, even if you find flaws. Your analysis is strictly limited to the changed lines.
    3.  {custom_rules_instruction}

    **--- OUTPUT FORMAT ---**
    - Your entire response MUST be a single, raw, valid JSON array string.
    - The response MUST start with `[` and end with `]`.
    - Each object in the array MUST have these keys: "line_number" (int), "issue_type" (str, one of the focused types), "comment" (str), and an optional "suggestion" (str).
    - If you find no issues that match your focus, you MUST return an empty JSON array: `[]`.
    - Do not add any text, explanations, apologies, or markdown formatting like ```json.
    - Before outputting, internally validate your response to ensure it is perfectly formed JSON. Pay special attention to escaping quotes (") and backslashes (\).
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
                    
                    parsed_json = robust_json_parser(json_str_cleaned)
                    
                    normalized_issues = [_normalize_issue(issue) for issue in parsed_json]
                    validated_result = ReviewResult(issues=normalized_issues)
                    review_results[file_path] = validated_result
                else:
                    raise json.JSONDecodeError("Could not find JSON array brackets `[]` in the response.", raw_response_text, 0)
            except (ValueError, SyntaxError, ValidationError) as e:
                print(f"⚠️ Failed to parse/validate LLM response for {file_path}. Response was: '{raw_response_text}'. Error: {e}")
                review_results[file_path] = ReviewResult(issues=[])

        except Exception as e:
            print(f"\n⚠️ Critical error during LLM call for {file_path}: {e}")
            review_results[file_path] = ReviewResult(issues=[])

    return review_results