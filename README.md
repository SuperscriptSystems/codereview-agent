# CodeReview Agent

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

AI-powered, context-aware code review tooling for local repositories and pull requests.

## Status

The active implementation is the root TypeScript reviewer.

- Source code lives in `src/`
- OpenCode runtime config is always loaded from the bundled `reviewer-opencode.json`
- Reviewer-specific settings live in `review-config.json`
- `.codereview.yml` is kept only as temporary legacy migration reference

## Quick Start

```bash
git clone https://github.com/<your-org>/codereview-agent
cd codereview-agent
npm install
npm run review -- --repo-path . --base-ref HEAD~1 --head-ref HEAD
```

## Usage

Review the last commit range:

```bash
npm run review -- --repo-path . --base-ref HEAD~1 --head-ref HEAD
```

Review staged files:

```bash
npm run review -- --repo-path . --staged
```

Verify reviewer auth and connectivity:

```bash
npm run check:reviewer -- --repo-path . --trace
```

Run Jira assessment:

```bash
npm run assess -- --repo-path . --base-ref HEAD~1 --head-ref HEAD
```

## Configuration

OpenCode runtime settings always come from the bundled `reviewer-opencode.json`.

Reviews start directly with the configured `reviewer` agent, using OpenCode's native model-specific system prompt. Review scope, reporting criteria, and the JSON output format are passed as the review task rather than a replacement system prompt. If OpenCode reports that `reviewer` is missing, the run switches to the built-in `general` agent with the same task and read-only permissions, and uses it for subsequent batches. Agent discovery is performed by `check-reviewer` only.

Reviewer-specific settings live in repo-local `review-config.json` when present, with bundled fallback defaults.

Repositories can provide additional review criteria in a root-level `reviewer-instructions.md`. Range and pull-request reviews load the file from the trusted base ref; staged reviews load it from `HEAD`. Missing or empty files leave the standard reviewer behavior unchanged. The file must be a regular file no larger than 64 KiB and cannot override review scope, tool restrictions, security requirements, or the structured output format.

The contents of `reviewer-instructions.md` are explicitly included in every batch's review task, including fallback requests to `general`, so OpenCode receives the project-specific criteria alongside the diff.

JSON output is requested through OpenCode's `json_schema` format and validated against the review schema. Native structured results are used immediately; a plain-text JSON fallback is requested only when the response contains no usable structured or JSON payload.

## Review timing and diagnostics

- Startup checks HTTP health and initializes the target repository through `/path` before starting a review. Repository initialization has a 60-second deadline; ordinary API requests have a 15-second deadline.
- Prompts use OpenCode's asynchronous API. Each turn is submitted once and its result is matched by message ID, using session status and events to wait for completion. A long analysis does not cause the prompt to be resubmitted after a 300-second HTTP headers timeout.
- The configured batch timeout includes session creation, analysis, and JSON formatting. The total review timeout cancels the active batch and prevents subsequent batches from starting.
- CI logs show stage timings and prompt progress every 30 seconds, including active tools and provider retry status. Internal OpenCode debug logs are captured in a bounded, secret-redacted buffer and included when a request fails. Client shutdown cancels pending work and retries.

Key config fields:

- `review.maxContextFiles`
- `review.focusAreas`
- `review.customRules`
- `review.filtering`
- `review.generatedFiles`
- `review.testKeywords`

Optional integrations use these environment variables:

- Jira: `JIRA_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`
- GitHub: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_PR_NUMBER`
- Bitbucket: `BITBUCKET_ACCESS_TOKEN`, or `BITBUCKET_TOKEN` + `BITBUCKET_USER_EMAIL`, or `BITBUCKET_APP_USERNAME` + `BITBUCKET_APP_PASSWORD`, plus `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG`, `BITBUCKET_PR_ID`

## Quality Checks

```bash
npm test
npm run build
```

## 🔄 CI/CD Integration

Legacy / pending migration: the examples below still describe the old Docker-based integration path and have not yet been rewritten for the root TypeScript reviewer.

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
              --env OPENAI_API_KEY=$OPENAI_API_KEY \
              --env BITBUCKET_ACCESS_TOKEN=$BITBUCKET_ACCESS_TOKEN \
              --env BITBUCKET_TOKEN=$BITBUCKET_TOKEN \
              --env BITBUCKET_USER_EMAIL=$BITBUCKET_USER_EMAIL \
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
    branches: ['main']

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
            --env OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }} \
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
