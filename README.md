AI Code Review Agent
An intelligent, context-aware code review agent powered by Large Language Models. This CLI tool performs a two-phase analysis on your local Git repositories to provide deep, relevant, and actionable feedback on your code changes.

Key Features
🧠 Two-Phase Analysis:
Context Building: The agent first intelligently determines the minimal sufficient context required for a comprehensive review by analyzing dependencies, not just the changed files.
Code Review: It then performs a detailed review based on the gathered context, focusing on logic, style, security, and more.
🤖 LLM Agnostic: Works with any OpenAI-compatible API. Defaults to using powerful and cost-effective models via OpenRouter.
🔧 Highly Configurable: Use a simple .codereview.yml file to define custom review rules, specify focus areas, and filter files.
💻 Local First: A pure Command-Line Interface (CLI) tool that operates on your local Git repository.
🚀 CI/CD Ready: Easily integrate into any CI/CD pipeline (like Bitbucket Pipelines or GitHub Actions) that supports Docker.

How It Works
The agent mimics the workflow of an expert human reviewer:
Initial Analysis: It takes a commit range (git diff) as input.
Iterative Context Building: The "Context Builder" agent inspects the changes and requests additional files from the project that are relevant to the review. This process repeats until the agent confirms the context is sufficient.
In-Depth Review: The "Reviewer" agent receives the complete context (changed files + relevant files) and performs a deep analysis, providing feedback only on the files that were actually changed.
This approach allows the agent to find deeper issues, such as API contract violations or unintended side effects, which would be missed by tools that only analyze the diff.
Installation
This project is managed with Poetry.
Clone the repository:

git clone https://github.com/YourUsername/CodeReviewAgent.git
cd CodeReviewAgent

Use code with caution.
Install dependencies using Poetry:

poetry install

1.  Configuration
    Before the first run, you need to configure your API keys and project settings.

        			1. API Key Setup
        				Create a .env file in the root of the project:
        				Generated code
        				touch .env
        				Use code with caution.

        			2. Add your LLM API key to the .env file. By default, the agent uses OpenRouter.
        			# Get your key from https://openrouter.ai/

        				LLM_API_KEY="sk-or-..."

2.  Project-Specific Configuration (Optional)
    You can create a .codereview.yml file in the root of the project you want to review. This allows you to define custom rules and settings for each repository.
    https://github.com/ExilionTechnologies/CodeReviewAgent/blob/main/.codereview.yml

3.  Usage
    The agent is run as a CLI tool from within the Poetry environment

        Basic Review (Last Commit)
        To review the changes introduced in the last commit (HEAD~1..HEAD):

        poetry run code-review-agent

        Reviewing a Specific Commit Range or Branch
        Use the --base-ref and --head-ref options to specify a range.

            poetry run code-review-agent --base-ref main --head-ref my-feature-branch

        Reviewing Staged Files (Pre-commit)
        Use the --staged flag to review files you have staged for the next commit.

            poetry run code-review-agent --staged

