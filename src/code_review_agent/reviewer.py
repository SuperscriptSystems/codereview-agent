import instructor
from openai import OpenAI
from .models import ReviewResult

_client = None

def get_client() -> OpenAI:

    global _client
    if _client is None:

        _client = instructor.patch(OpenAI())
    return _client

# --- END OF CHANGES ---


def review_code_changes(file_path: str, file_diff: str, file_content: str) -> ReviewResult:
    
    print(f"🤖 Analyzing file: {file_path}...")

    system_prompt = (
        "You are an expert code review assistant specializing in multiple languages. Your task is to analyze the "
        "provided 'git diff' and identify potential issues. Your feedback must be "
        "tailored to the programming language of the file."
        "\n\n"
        "### General Instructions:\n"
        "- Focus on logic errors, code style violations, potential security vulnerabilities, and suggestions for improvement.\n"
        "- Do not comment on trivial things or formatting that can be fixed by an auto-formatter.\n"
        "- If no issues are found, return an empty list.\n"
        "\n\n"
        "### Language-Specific Guidelines:\n"
        "- **For C# files (.cs, .csproj):** Act as a senior .NET developer. Pay close attention to:\n"
        "  - Adherence to Microsoft's C# Coding Conventions (e.g., PascalCase for methods/properties, camelCase for local variables).\n"
        "  - Proper use of LINQ (e.g., suggest more efficient queries).\n"
        "  - Correct async/await patterns (e.g., avoiding `async void`, using `ConfigureAwait(false)` in libraries).\n"
        "  - Null reference handling (e.g., suggest using null-conditional operators `?.` or checks).\n"
        "  - Proper use of properties instead of public fields.\n"
        "- **For Python files (.py):** Follow PEP 8 guidelines and Pythonic best practices.\n"
        "- **For JavaScript/TypeScript files (.js, .ts):** Follow modern best practices (e.g., use of `const`/`let`, async/await over promises)."
    )

    user_prompt = f"""
    Please review the following changes for the file `{file_path}`.

    **Full File Content:**
    ```
    {file_content}
    ```

    **Git Diff of Changes to Review:**
    ```diff
    {file_diff}
    ```

    Analyze the diff within the context of the full file and return a list of issues.
    """

    try:
        client = get_client()
        review = client.chat.completions.create(
            model="gpt-4o",
            response_model=ReviewResult,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_retries=2,
        )
        return review
    except Exception as e:
        print(f"An error occurred while analyzing {file_path}: {e}")
        return ReviewResult(issues=[])