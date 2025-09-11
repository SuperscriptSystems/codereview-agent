# CodeReview Agent

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

AI-powered, context-aware code review agent powered by Large Language Models. This CLI tool performs a multi-phase analysis of your local Git repositories to provide deep, relevant, and actionable feedback on your code changes, mimicking the workflow of an expert human reviewer.

The agent is **pragmatic** — it focuses on concrete bugs and significant improvements while avoiding unhelpful, speculative, or redundant comments.

---

## 📑 Table of Contents

* [Key Features](#-key-features)
* [Quick Start](#-quick-start)
* [Installation](#-installation)
* [Usage](#-usage)
* [Configuration](#-configuration)
* [CI/CD Integration](#-cicd-integration)
* [Contributing](#-contributing)
* [License](#-license)

---

## 🌟 Key Features

* 🧠 **Smart Context Building**: Beyond simple diffs, uses:

  * **Static Analysis (Tree-sitter)** to detect dependencies.
  * **Layered LLM Analysis** to request additional files intelligently.
* 🤖 **LLM Agnostic**: Works with any OpenAI-compatible API (OpenRouter by default).
* 🔧 **Highly Configurable**: Customize review rules, focus areas, and filtering via `.codereview.yml`.
* 💻 **Local First**: CLI tool runs directly on your local Git repository — perfect for pre-commit checks.
* 🚀 **CI/CD Ready**: Distributed as a Docker image, integrates easily with Bitbucket Pipelines and GitHub Actions.
* 🗣️ **Jira Integration**: Fetches Jira task context and posts assessments back after merge.
* ✨ **Clean PRs**: Removes outdated comments automatically for a cleaner review history.

---

## ⚡ Quick Start

```bash
git clone https://github.com/<your-org>/codereview-agent
cd codereview-agent
poetry install
poetry run code-review-agent review
```

---

## 🛠️ Installation

This project is managed with [Poetry](https://python-poetry.org).

1. Clone the repository:

   ```bash
   git clone <your-repository-url>
   cd codereview-agent
   ```

2. Install dependencies:

   ```bash
   poetry install
   ```

---

## 🚀 Usage

Run from within the Poetry environment.

**Basic Review (Last Commit)**

```bash
poetry run code-review-agent review
```

**Review a Branch or Commit Range**

```bash
poetry run code-review-agent review --base-ref main --head-ref my-feature-branch
```

**Pre-commit Review (Staged Files)**

```bash
poetry run code-review-agent review --staged
```

**Focus on Specific Areas**

```bash
poetry run code-review-agent review --focus Security --focus LogicError
```

**Enable Verbose Debugging**

```bash
poetry run code-review-agent review --trace
```

*(Focus options: LogicError, CodeStyle, Security, Suggestion, TestCoverage, Clarity, Performance, Other)*

---

## ⚙️ Configuration

### 1. Environment Variables (.env)

Create a `.env` file at the root:

```env
LLM_API_KEY="sk-or-..."

# Bitbucket Integration
BITBUCKET_APP_USERNAME="my-bitbucket-username"
BITBUCKET_APP_PASSWORD="your_app_password"

# Jira Integration (optional)
JIRA_URL="https://your-company.atlassian.net"
JIRA_USER_EMAIL="your-email@company.com"
JIRA_API_TOKEN="your_jira_api_token"
```

### 2. Project Configuration (.codereview\.yml)

Example config:

```yaml
llm:
  provider: "openai"
  models:
    context_builder: "gpt-4o"
    reviewer: "gpt-4o"
    assessor: "gpt-4o"

max_context_files: 25

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

test_keywords: ['test', 'spec', 'fixture']

review_focus:
  - "Security"
  - "Performance"
  - "LogicError"

review_rules:
  - "All public functions must have a docstring."
  - "Pay close attention to potential N+1 query problems."
```

---

## 🔄 CI/CD Integration

Distributed as a public Docker image: `umykhailo/codereviewagent:latest`

### Example: Bitbucket Pipelines

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          name: Run AI Code Review
          image: atlassian/default-image:4
          size: 2x
          services:
            - docker
          script:
            - export IMAGE_NAME="umykhailo/codereviewagent:latest"
            - export AGENT_ARGS="review --repo-path . --base-ref origin/${BITBUCKET_PR_DESTINATION_BRANCH} --head-ref ${BITBUCKET_COMMIT}"
            - if echo "${BITBUCKET_COMMIT_MESSAGE}" | grep -q "\[trace-agent\]"; then export AGENT_ARGS="$AGENT_ARGS --trace"; fi
            - >
              docker run \
              --volume ${BITBUCKET_CLONE_DIR}:/repo \
              --workdir /repo \
              --env LLM_API_KEY=$LLM_API_KEY \
              --env BITBUCKET_APP_USERNAME=$BITBUCKET_APP_USERNAME \
              --env BITBUCKET_APP_PASSWORD=$BITBUCKET_APP_PASSWORD \
              --env JIRA_URL=$JIRA_URL \
              --env JIRA_USER_EMAIL=$JIRA_USER_EMAIL \
              --env JIRA_API_TOKEN=$JIRA_API_TOKEN \
              --env BITBUCKET_PR_ID=$BITBUCKET_PR_ID \
              --env BITBUCKET_REPO_SLUG=$BITBUCKET_REPO_SLUG \
              --env BITBUCKET_WORKSPACE=$BITBUCKET_WORKSPACE \
              --env BITBUCKET_PR_DESTINATION_BRANCH=$BITBUCKET_PR_DESTINATION_BRANCH \
              --env BITBUCKET_COMMIT=$BITBUCKET_COMMIT \
              --env BITBUCKET_BRANCH=${BITBUCKET_BRANCH} \
              $IMAGE_NAME $AGENT_ARGS
```

### Example: GitHub Actions

```yaml
name: AI Code Review

on:
  pull_request:
    branches: [ "main" ]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Run AI Code Review
        run: |
          docker run \
            --volume ${{ github.workspace }}:/repo \
            --workdir /repo \
            --env LLM_API_KEY=${{ secrets.LLM_API_KEY }} \
            umykhailo/codereviewagent:latest \
            review --repo-path . --base-ref origin/main --head-ref ${{ github.sha }}
```

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

---

## 📄 License

This project is licensed under the **Apache 2.0 License** — see the [LICENSE](LICENSE) file for details.

---

👨‍💻 Developed and maintained by [Superscript Systems](https://superscriptsystems.com).
