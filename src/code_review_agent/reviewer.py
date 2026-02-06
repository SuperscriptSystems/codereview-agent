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

    normalized['file_path'] = str(raw_issue.get('file_path') or raw_issue.get('filePath') or '')

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
    jira_details: str,
    review_rules: List[str],
    llm_config: dict,
    focus_areas: List[IssueType]
) -> Dict[str, ReviewResult]:
    
    client = get_client(llm_config)
    model = llm_config.get('models', {}).get('reviewer', 'gpt-5.2-codex')

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
    You are an expert AI code review assistant. You will be given a set of annotated files and a separate Git Diff block.
    
    **--- INPUT FORMAT EXPLANATION ---**
    For each file, you will receive code in this format: `[old_lineno] [new_lineno] [marker] [code]`
    
    **Marker Definitions:**
    - `+`: A new or modified line. This is the new version of the line.
    - `-`: An old or removed line. This is the old version of the line.
    - ` ` (a space, no +/-): This line is unchanged and provided for context only.

    **--- BEHAVIORAL RULES (MOST IMPORTANT) ---**
    1.  **Assume Intent is Correct:** Your job is to find bugs **within the new code**.
    2.  **Be Helpful, Not Annoying.**
    3.  **Focus on Concrete Technical Errors.**
    4.  **High Confidence Only.**
    5.  **DO NOT REPORT COMPILER/LINTER ERRORS.**
    6.  **No Evidence, No Comment.**
    7.  **IGNORE TEST FILES.**
    8.  **Consolidate Feedback.**

    **--- YOUR TASK ---**
    Analyze the **annotated files** and the **Git Diff** to identify **concrete, existing issues** ONLY in the changed lines.

    **--- ISSUE CATEGORY DEFINITIONS ---**
    {definitions_table}

    **--- CRITICAL RULES ---**
    1.  **SCOPE:** Your comments and `line_number` MUST correspond to the **new line number** of lines marked with `+`.
    2.  **FOCUS:** You are strictly forbidden from reporting any issue types that are not in this list: **{', '.join(focus_areas)}**.
    3.  **EVIDENCE REQUIRED (NO SPECULATION).**
    4.  {custom_rules_instruction}

    **--- OUTPUT FORMAT ---**
    - Your entire response MUST be a single, raw, valid JSON array string.
    - Each object in the array MUST have these keys:
        - "file_path": The path of the file where the issue is located.
        - "line_number": The new line number (int).
        - "issue_type": The category (str).
        - "comment": Your detailed feedback (str).
        - "suggestion": Direct code fix (optional str).
    - If no issues are found, return `[]`.
    - Do not add any text, explanations, or markdown formatting.
    """

    all_files_annotated = []
    full_diff_parts = []
    
    for file_path, diff_content in changed_files_map.items():
        full_file_content = final_context_content.get(file_path, "File content not available.")
        
        # AI Cleanup Context
        cleaned_content = git_utils.cleanup_code_context(file_path, full_file_content, diff_content)
        
        # If the file was cleaned (C# usually), we might want to show more of it
        # for now let's just use the cleaned content for hunk annotation
        annotated_content = git_utils.create_annotated_file(cleaned_content, diff_content)
        
        all_files_annotated.append(f"### FILE: {file_path}\n{annotated_content}")
        full_diff_parts.append(f"--- {file_path} ---\n{diff_content}")

    full_diff_text = "\n".join(full_diff_parts)
    all_files_annotated_text = "\n\n".join(all_files_annotated)

    user_prompt = f"""
    {jira_details}

    **--- GIT DIFF BLOCK ---**
    ```diff
    {full_diff_text}
    ```

    **--- ANNOTATED FILES CONTENT ---**
    {all_files_annotated_text}

    Please review all these files and the overall change. Return your findings as a raw JSON array string.
    """

    logger.info(f"Reviewing {len(changed_files_map)} files at once using model {model}")

    try:
        response = client.responses.create(
            model=model,
            input=f"{system_prompt}\n\n{user_prompt}",
        )
        
        raw_response_text = ""
        for item in response.output:
            if hasattr(item, "content") and item.content:
                for part in item.content:
                    if hasattr(part, "text"):
                        raw_response_text = part.text
                        break
            if not raw_response_text:
                raw_response_text = getattr(item, "text", "") or getattr(item, "message", "")
            if raw_response_text:
                break
        
        logger.debug(f"Raw LLM response:\n{raw_response_text}")

        start_index = raw_response_text.find('[')
        end_index = raw_response_text.rfind(']')

        if start_index != -1 and end_index != -1 and end_index > start_index:
            json_str_cleaned = raw_response_text[start_index : end_index + 1]
            parsed_json = robust_json_parser(json_str_cleaned)
            
            # Group issues by file_path
            issues_by_file = {}
            for raw_issue in parsed_json:
                normalized = _normalize_issue(raw_issue)
                fp = normalized.get('file_path')
                if not fp or fp not in changed_files_map:
                    # Try to find the closest match if the LLM hallucinated the path slightly
                    matches = [path for path in changed_files_map.keys() if fp in path or path in fp]
                    if matches:
                        fp = matches[0]
                    else:
                        logger.warning(f"Issue refers to unknown file path: {fp}. Skipping.")
                        continue
                
                if fp in changed_files_map:
                    normalized['file_path'] = fp
                    if fp not in issues_by_file:
                        issues_by_file[fp] = []
                    issues_by_file[fp].append(normalized)

            # Convert to final Dict[str, ReviewResult]
            review_results = {}
            for file_path in changed_files_map.keys():
                issues = issues_by_file.get(file_path, [])
                review_results[file_path] = ReviewResult(issues=issues)
            
            return review_results
        else:
            logger.info("No valid JSON array found in LLM response. Assuming no issues.")
            return {fp: ReviewResult(issues=[]) for fp in changed_files_map.keys()}

    except Exception as e:
        logger.error(f"Critical error during combined LLM call: {e}", exc_info=True)
        return {fp: ReviewResult(issues=[]) for fp in changed_files_map.keys()}