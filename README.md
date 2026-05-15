# CodeReview Agent

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

AI-powered, context-aware code review tooling for local repositories and pull requests.

## Status

The active implementation is the root TypeScript reviewer.

- Source code lives in `src/`
- OpenCode runtime config lives in `opencode.json`
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

OpenCode runtime settings live in `opencode.json`.

Reviewer-specific settings live in `review-config.json`.

Key config fields:

- `review.maxContextFiles`
- `review.focusAreas`
- `review.customRules`
- `review.filtering`
- `review.testKeywords`

Optional integrations use these environment variables:

- Jira: `JIRA_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN`
- GitHub: `GITHUB_TOKEN`, `GITHUB_REPOSITORY`, `GITHUB_PR_NUMBER`
- Bitbucket: `BITBUCKET_APP_USERNAME`, `BITBUCKET_APP_PASSWORD`, `BITBUCKET_WORKSPACE`, `BITBUCKET_REPO_SLUG`, `BITBUCKET_PR_ID`

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
