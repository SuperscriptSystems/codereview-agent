import json
import ast
import logging
from typing import Dict, List, Any
from pydantic import ValidationError
from .models import ReviewResult, IssueType
from .llm_client import get_client
from . import git_utils

logger = logging.getLogger(__name__)

def robust_json_parser(json_string: str) -> Any:
    """
    Tries to parse a JSON-like string using multiple strategies.
    1. Try standard `json.loads`.
    2. If it fails, try less strict `ast.literal_eval`.
    """
    try:
        return json.loads(json_string, strict=False)
    except json.JSONDecodeError as e:
        logger.debug(f"json.loads failed: {e}. Falling back to ast.literal_eval.")
        try:
            return ast.literal_eval(json_string)
        except (ValueError, SyntaxError) as ast_e:
            logger.debug(f"ast.literal_eval also failed: {ast_e}.")
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
    
    logger.debug(f"Normalized issue: {normalized}")

    return normalized

def run_review(
    changed_files_map: Dict[str, str],
    final_context_content: Dict[str, str],
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
        custom_rules_instruction = f"**CUSTOM RULES:**\n- {rules_text}"


    definitions_table = """
    | Category       | Definition                                                                                                                              |
    |----------------|-----------------------------------------------------------------------------------------------------------------------------------------|
    | `LogicError`   | **Actual bugs or flaws in the current logic.** Code is valid but will produce incorrect or unintended results **right now**.            |
    | `CodeStyle`    | Violations of coding conventions, readability, or maintainability that make the **current code** harder to understand.                  |
    | `Security`     | **Existing vulnerabilities** that could be exploited in the current code (e.g., SQL injection, XSS).                                    |
    | `Suggestion`   | The code works, but the **current implementation** could be improved (e.g., refactoring, using modern features).                        |
    | `TestCoverage` | **New logic or features** that are not covered by tests, or insufficient edge case testing for the **current changes**.                 |
    | `Clarity`      | The **current code** is functionally correct but hard to understand (e.g., unclear names, missing comments for complex logic).          |
    | `Performance`  | The **current implementation** may cause performance bottlenecks (e.g., N+1 queries, inefficient loops).                                |
    | `Other`        | Valid, **existing issues** that do not fit into other categories.                                                                       |                                                                                   |
    """    

    system_prompt = f"""
    You are an expert AI code review assistant. You will be given an annotated file where each line is prefixed with its old and new line number, a change marker (`+`, `-`, or space), and provide feedback as a clean JSON array.

    **--- INPUT FORMAT EXPLANATION ---**
    You will receive code in this format: `[old_lineno] [new_lineno] [marker] [code]`
    
    **Marker Definitions:**
    - `+`: A new or modified line. This is the new version of the line.
    - `-`: An old or removed line. This is the old version of the line.
    - ` ` (a space, no +/-): This line is unchanged and provided for context only.

    **Example:**
    `   150               - await oldMethodAsync();`
    `         152         + await newMethodAsync(newArgument);`
    `   153   153           // Unchanged context line`

    **--- BEHAVIORAL RULES (MOST IMPORTANT) ---**
    1.  **Be Helpful, Not Annoying:** Be friendly and assume you might be wrong. Your goal is to help, not to criticize.
    2.  **Focus on Concrete Technical Errors:** Prioritize clear, objective issues like copy-paste errors, logical flaws, N+1 query problems, race conditions, and similar technical bugs.
    3.  **No Evidence, No Comment:** If a change *could* potentially cause a problem elsewhere (e.g., an interface change), but you have no direct evidence from the provided context that it *does* cause a problem, you MUST ignore it. Do not speculate about hypothetical issues.
    4.  **IGNORE TEST FILES:** You are strictly forbidden from analyzing or commenting on test files. If a file path contains "Test" or "Spec", or is inside a "tests" or "specs" directory, you MUST ignore it and return an empty result for that file.
    5.  **Consolidate Feedback:** Before generating the output, review all the potential issues you've found for a single file. **You MUST merge related or overlapping comments into a single, comprehensive comment.** If you identify the same underlying problem from different angles, report it ONLY ONCE under the most severe category. Your goal is high-signal, low-noise feedback.

    **--- YOUR TASK ---**
    Analyze the **annotated file content** to identify **concrete, existing issues** ONLY in the changed lines (marked with `+` or `-`).

    **--- ISSUE CATEGORY DEFINITIONS ---**
    You MUST classify every issue using one of the types from the table below.
    {definitions_table}

    
    **--- CRITICAL RULES ---**
    1.  **SCOPE:** Your comments and `line_number` MUST correspond to lines marked with `+` or `-`. DO NOT comment on unchanged 
    2.  **FOCUS:** You are strictly forbidden from reporting any issue types that are not in this list: **{', '.join(focus_areas)}**. If you find issues of other types, you MUST ignore them.
    3.  **PRAGMATISM:** Focus exclusively on **actual, present problems**. Do not report on potential, hypothetical, or future issues. For example, do not suggest adding a feature that is "out of scope" for the current changes. Your feedback should be actionable for the developer **right now**.
    4.  **SUGGESTION FORMAT:** Your primary goal for the `suggestion` field is to provide a **direct code fix**.
        -   If a fix involves changing one or more lines, you MUST provide the complete, corrected line(s) of code in the `suggestion` field as a drop-in replacement.
        -   The `suggestion` field should contain **code, not text**, unless a code fix is impossible (e.g., "add a missing unit test").
    5.  **AVOID REDUNDANT SUGGESTIONS:** Before making a suggestion, you MUST check if the existing code already implements the best practice you are recommending. **DO NOT suggest a change that is identical to the existing code.** Your feedback must provide new, valuable information.
    6.  **RESPECT GUARD CLAUSES:** Before reporting a potential `NullReferenceException` or similar error, you MUST check the preceding lines for "guard clauses" or null checks (e.g., `if (myObject == null) return;` or `if (myObject != null) { ... }`). If the potentially problematic code is inside a block that correctly checks for null, you MUST NOT report it as an issue.    
    7.  {custom_rules_instruction}


    **--- OUTPUT FORMAT ---**
    - Your entire response MUST be a single, raw, valid JSON array string.
    - The response MUST start with `[` and end with `]`.
    - Each object in the array MUST have these keys: "line_number" (int), "issue_type" (str, one of the focused types), "comment" (str), and an optional "suggestion" (str).
    - **Crucial:** If you find absolutely no issues that match your focus and instructions, you MUST return an empty JSON array: `[]`. It is a valid and expected response.
    - Do not add any text, explanations, apologies, or markdown formatting like ```json.
    - Before outputting, internally validate your response to ensure it is perfectly formed JSON. Pay special attention to escaping quotes (") and backslashes (\\).
    """

    review_results = {}

    for file_path, diff_content in changed_files_map.items():
        logger.info(f"Reviewing file: {file_path}")
        full_file_content = final_context_content.get(file_path, "File content not available.")

        annotated_content = git_utils.create_annotated_file(full_file_content, diff_content)
        
        user_prompt = f"""
        Please review the following annotated file: `{file_path}`.
        Return your findings as a raw JSON array string.

        **Annotated File Content for `{file_path}`:**
        ```
        {annotated_content}
        ```
        """


        try:
            logger.debug(f"--- System Prompt for {file_path} ---\n{system_prompt}")
            logger.debug(f"--- User Prompt for {file_path} ---\n{user_prompt}")

            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ]
            )
            raw_response_text = response.choices[0].message.content.strip()
            logger.debug(f"Raw LLM response for {file_path}:\n{raw_response_text}")

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
                    logger.info(f"No valid JSON array found for {file_path}. Assuming no issues.")
                    raise json.JSONDecodeError("Could not find JSON array brackets `[]` in the response.", raw_response_text, 0)
            except (ValueError, SyntaxError, ValidationError) as e:
                logger.warning(f"Failed to parse/validate LLM response for {file_path}. Error: {e}")
                logger.debug(f"Problematic response was: '{raw_response_text}'")
                review_results[file_path] = ReviewResult(issues=[])

        except Exception as e:
            logger.error(f"Critical error during LLM call for {file_path}: {e}", exc_info=True)
            review_results[file_path] = ReviewResult(issues=[])

    return review_results