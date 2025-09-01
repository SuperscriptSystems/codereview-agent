# **AI Code Review Agent**

An intelligent, context-aware code review agent powered by Large Language Models. This CLI tool performs a sophisticated, multi-phase analysis on your local Git repositories to provide deep, relevant, and actionable feedback on your code changes, mimicking the workflow of an expert human reviewer.

The agent is designed to be **pragmatic**, focusing on concrete bugs and significant improvements while avoiding unhelpful, speculative, or redundant comments.

## 🌟 **Key Features**

- 🧠 **Smart Context Building**: Goes beyond a simple diff. The agent uses a hybrid approach to build context:

  - **Static Analysis (Tree-sitter)**: Automatically detects dependencies like interfaces, base classes, and DTOs to pre-populate the context.
  - **Layered LLM Analysis**: Intelligently requests additional files based on a prioritized, layer-by-layer analysis of the changed files.

- 🤖 **LLM Agnostic**: Works with any OpenAI-compatible API. It is configured to use powerful and cost-effective models via OpenRouter by default.
- 🔧 **Highly Configurable**: Use a simple .codereview.yml file in your project to define custom review rules, specify focus areas (e.g., Security, Performance), filter files, and manage models.
- 💻 **Local First**: A pure Command-Line Interface (CLI) tool that operates on your local Git repository. Perfect for pre-commit checks.
- 🚀 **CI/CD Ready**: Packaged as a Docker image for easy and fast integration into any CI/CD pipeline, including Bitbucket Pipelines and GitHub Actions.
- 🗣️ **Jira Integration**: Automatically fetches context from Jira tasks (summary and description) based on the branch name or commit messages to better understand the business goal of the changes. It can also post a final assessment back to the Jira task after a PR is merged.
- ✨ **Clean PRs**: Automatically cleans up its old comments from a Pull Request when new changes are pushed, ensuring the PR conversation remains clean and relevant.

## 🛠️ **Installation**

This project is managed with [Poetry](https://python-poetry.org).

1.  **Clone the repository**:

        git clone <your-repository-url>
        cd code-review-agent

2.  **Install dependencies using Poetry**:

        poetry install

## ⚙️ **Configuration**

Before the first run, you need to configure API keys. Project-specific settings are optional.

### **1. Environment Variables (.env)**

Create a .env file in the root of the agent's project directory. This file should contain all your secret keys.

        # Get your key from https://openrouter.ai/ (default) or https://platform.openai.com/
        LLM_API_KEY="sk-or-..."

        # --- For Bitbucket Integration ---
        # Your Bitbucket username
        BITBUCKET_APP_USERNAME="my-bitbucket-username"
        # The App Password you generated with `pull-requests:write` permissions
        BITBUCKET_APP_PASSWORD="your_app_password"

        # --- For Jira Integration (Optional) ---
        JIRA_URL="https://your-company.atlassian.net"
        JIRA_USER_EMAIL="your-email@company.com"
        JIRA_API_TOKEN="your_jira_api_token"

### **1. Environment Variables (.env)**

Here is a full example of .codereview.yml:

        llm:
          provider: "openai" # "openrouter" is the default
          models:
            context_builder: "gpt-4o"
            reviewer: "gpt-4o"
            assessor: "gpt-4o"

        # --- Context building settings ---

        max_context_files: 25

        # --- File filtering settings ---

        filtering:
        ignored_extensions:
            - '.dll'
            - '.so'
            - '.exe'
            - '.png'
            - '.jpg'
            - '.jpeg'
            - '.gif'
            - '.svg'
            - '.min.js'
            - '.lock'
            - '.zip'
            - '.o'
            - '.a'
            - '.obj'
            - '.lib'
            - '.pdb'

        ignored_paths:
            - 'node_modules'
            - 'venv'
            - '.venv'
            - '.git'
            - '__pycache__'
            - 'dist'
            - 'build'
            - 'target'
            - '.next'
            - '.pytest_cache'

        # Keywords to identify and ignore test files

        test_keywords: ['test', 'spec', 'fixture']

        # --- Reviewer settings ---

        # Default focus areas if not specified via CLI.

        # If omitted, defaults to "LogicError" only.

        review_focus:

        - "Security"
        - "Performance"
        - "LogicError"

        # Custom rules for the reviewer agent.

        review_rules:

        - "All public functions must have a docstring."
        - "Pay close attention to potential N+1 query problems."

## 🚀 **Usage**

The agent is run as a CLI tool from within the Poetry environment.

**Basic Review (Last Commit)**

Reviews the changes between HEAD~1 and HEAD.

        poetry run code-review-agent review

**Reviewing a Specific Branch or Commit Range**

        # Review changes between a feature branch and main
        poetry run code-review-agent review --base-ref main --head-ref my-feature-branch
        or local last branch
        poetry run code-review-agent --repo-path "D:\Projects\Work\code-review"

**Reviewing Staged Files (Pre-commit)**

        poetry run code-review-agent review --staged

**Focusing the Review**

Use the `--focus` flag to narrow the scope of the review.

        # Check for security issues and logic errors only
        poetry run code-review-agent review --focus Security --focus LogicError

_(Possible values: LogicError, CodeStyle, Security, Suggestion, TestCoverage, Clarity, Performance, Other)_

**Enabling Trace Mode for Debugging**

Use the --trace flag to enable verbose logging.

        poetry run code-review-agent review --trace

## **🔄 CI/CD Integration**

The agent is packaged as a public Docker image: `umykhailo/codereviewagent:latest.`

### **Example for Bitbucket Pipelines**

1.  In your target repository's Repository settings -> Repository variables, add the necessary secured variables:
    The agent is packaged as a public Docker image: `LLM_API_KEY, BITBUCKET_APP_USERNAME, BITBUCKET_APP_PASSWORD,` and optionally the `JIRA*` variables.

2.  Add a bitbucket-pipelines.yml file to the root of your project:

          pipelines:
            pull-requests:
                '**':
                  - step:
                      name: Run AI Code Review
                      image: atlassian/default-image:4
                      size: 2x
                      services: - docker
                      script: - export IMAGE_NAME="umykhailo/codereviewagent:latest" - export AGENT_ARGS="review --repo-path . --base-ref origin/${BITBUCKET_PR_DESTINATION_BRANCH} --head-ref ${BITBUCKET_COMMIT}"
                              # Optional: Enable trace mode by including "[trace-agent]" in your commit message
                              - if echo "${BITBUCKET_COMMIT_MESSAGE}" | grep -q "\[trace-agent\]"; then export AGENT_ARGS="$AGENT_ARGS --trace"; fi
                              - >
                              docker run
                              --volume ${BITBUCKET_CLONE_DIR}:/repo
                              --workdir /repo
                              --env LLM_API_KEY=$LLM_API_KEY
                              --env BITBUCKET_APP_USERNAME=$BITBUCKET_APP_USERNAME
                              --env BITBUCKET_APP_PASSWORD=$BITBUCKET_APP_PASSWORD
                              --env JIRA_URL=$JIRA_URL
                              --env JIRA_USER_EMAIL=$JIRA_USER_EMAIL
                              --env JIRA_API_TOKEN=$JIRA_API_TOKEN
                              --env BITBUCKET_PR_ID=$BITBUCKET_PR_ID
                              --env BITBUCKET_REPO_SLUG=$BITBUCKET_REPO_SLUG
                              --env BITBUCKET_WORKSPACE=$BITBUCKET_WORKSPACE
                              --env BITBUCKET_PR_DESTINATION_BRANCH=$BITBUCKET_PR_DESTINATION_BRANCH
                              --env BITBUCKET_COMMIT=$BITBUCKET_COMMIT
                              --env BITBUCKET_BRANCH=${BITBUCKET_BRANCH}
                                      $IMAGE_NAME
                                      $AGENT_ARGS
            branches:
              main: # Or your primary branch
                - step:
                    name: "Post-Merge: Assess Task Relevance in Jira"
                    image: atlassian/default-image:4
                    size: '2x'
                    services: ['docker']
                    script:
                        - export IMAGE_NAME="umykhailo/codereviewagent:latest"
                        - >
                        docker run
                        --volume ${BITBUCKET_CLONE_DIR}:/repo
                        --workdir /repo
                        --env LLM_API_KEY=$LLM_API_KEY
                        --env JIRA_URL=$JIRA_URL
                        --env JIRA_USER_EMAIL=$JIRA_USER_EMAIL
                        --env JIRA_API_TOKEN=$JIRA_API_TOKEN
                        --env BITBUCKET_COMMIT_MESSAGE="$(git log -1 --pretty=%B ${BITBUCKET_COMMIT})"
                        $IMAGE_NAME
                        assess --repo-path "." --base-ref "${BITBUCKET_COMMIT}~1" --head-ref "${BITBUCKET_COMMIT}"
