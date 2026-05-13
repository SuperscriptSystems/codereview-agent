# ts-reviewer

OpenCode-native replacement for the legacy Python code review agent.

## Current Scope

This package currently provides:

- `review` command for staged or range-based review
- `assess` command for Jira assessment summaries
- Jira task lookup and Jira assessment comments
- GitHub PR publishing
- Bitbucket PR publishing
- project configuration through `opencode.json`

The reviewer now inspects repository context through OpenCode tools instead of receiving pre-expanded annotated file context.

Tool access for the reviewer is intentionally restricted to:

- safe read tools: `read`, `glob`, `grep`
- safe Git inspection commands: `git diff`, `git log`, `git show`, `git status`, `git rev-parse`

The legacy Python reviewer still remains in the repository during migration.

## Install

```bash
npm install
```

## Run

Review the last commit range:

```bash
npm run review -- --repo-path .. --base-ref HEAD~1 --head-ref HEAD
```

Review staged files:

```bash
npm run review -- --repo-path .. --staged
```

Verify reviewer auth and connectivity without a git range:

```bash
npm run check:reviewer -- --repo-path . --trace
```

Run Jira assessment:

```bash
npm run assess -- --repo-path .. --base-ref HEAD~1 --head-ref HEAD
```

Jira assessment runs separately from `review`. The `review` command does not fetch or post Jira data.

## Config

Configuration lives in `opencode.json`.

Project-specific review settings are stored under the `review` key.

Key fields:

- `review.maxContextFiles`
- `review.focusAreas`
- `review.customRules`
- `review.filtering`
- `review.testKeywords`

`review.maxContextFiles` is now secondary during the OpenCode-native reviewer migration and is no longer part of the primary review path.

## Environment

LLM and OpenCode provider credentials should be configured for your local OpenCode setup.

Optional integrations:

- Jira:
  - `JIRA_URL`
  - `JIRA_USER_EMAIL`
  - `JIRA_API_TOKEN`
- GitHub:
  - `GITHUB_TOKEN`
  - `GITHUB_REPOSITORY`
  - `GITHUB_PR_NUMBER`
- Bitbucket:
  - `BITBUCKET_APP_USERNAME`
  - `BITBUCKET_APP_PASSWORD`
  - `BITBUCKET_WORKSPACE`
  - `BITBUCKET_REPO_SLUG`
  - `BITBUCKET_PR_ID`

## Quality Checks

```bash
npm test
npm run build
```

## Notes

- The current OpenCode integration still parses JSON from text responses.
- Legacy context-builder and annotated-file helpers remain in the repository during migration, but they are no longer part of the primary review path.
