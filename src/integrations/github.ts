import type { CodeIssue } from "../core/models.js"
import { logger } from "../core/logger.js"

const botLogin = "github-actions[bot]"

export async function handlePrResults(allIssues: CodeIssue[], filesWithIssues: Record<string, CodeIssue[]>): Promise<void> {
  const token = process.env.GITHUB_TOKEN
  const repository = process.env.GITHUB_REPOSITORY
  const prNumber = process.env.GITHUB_PR_NUMBER

  if (!token || !repository || !prNumber) {
    throw new Error("GitHub PR environment is not fully configured.")
  }

  const api = createGithubApi(token)
  const [owner, repo] = repository.split("/")

  await cleanupComments(api, owner, repo, prNumber)

  if (allIssues.length === 0) {
    await api(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "Excellent work! The AI agent didn't find any issues." }),
    })
    await tryApprovePullRequest(api, owner, repo, prNumber)
    return
  }

  const headSha = await getLatestCommitSha(api, owner, repo, prNumber)
  const summaryBody = buildSummaryComment(allIssues)

  await api(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: summaryBody }),
  })

  const comments = Object.entries(filesWithIssues).flatMap(([filePath, issues]) =>
    issues.map((issue) => ({
      path: filePath,
      line: issue.lineNumber,
      side: "RIGHT",
      body: buildIssueComment(issue),
    })),
  )

  for (let index = 0; index < comments.length; index += 30) {
    await api(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        commit_id: headSha,
        event: "COMMENT",
        comments: comments.slice(index, index + 30),
      }),
    })
  }

  await tryApprovePullRequest(api, owner, repo, prNumber)
}

export async function approvePullRequest(): Promise<void> {
  const token = process.env.GITHUB_TOKEN
  const repository = process.env.GITHUB_REPOSITORY
  const prNumber = process.env.GITHUB_PR_NUMBER

  if (!token || !repository || !prNumber) {
    throw new Error("GitHub PR environment is not fully configured.")
  }

  const api = createGithubApi(token)
  const [owner, repo] = repository.split("/")

  await tryApprovePullRequest(api, owner, repo, prNumber)
}

function createGithubApi(token: string) {
  return async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    })

    if (!response.ok && response.status !== 404) {
      const body = await response.text()
      throw new GitHubApiError(path, response.status, body)
    }

    if (response.status === 204) {
      return null
    }

    const text = await response.text()
    return text ? (JSON.parse(text) as unknown) : null
  }
}

class GitHubApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`GitHub API ${path} failed: ${status} ${responseBody}`)
  }
}

async function cleanupComments(
  api: ReturnType<typeof createGithubApi>,
  owner: string,
  repo: string,
  prNumber: string,
): Promise<void> {
  logger.info("Cleaning previous GitHub bot comments.")

  const reviewComments = await getPaginatedGithubCollection<{
    id: number
    in_reply_to_id?: number
    user?: { login?: string }
  }>(api, `/repos/${owner}/${repo}/pulls/${prNumber}/comments`)
  const issueComments = await getPaginatedGithubCollection<{
    id: number
    user?: { login?: string }
  }>(api, `/repos/${owner}/${repo}/issues/${prNumber}/comments`)
  const reviews = await getPaginatedGithubCollection<{
    id: number
    state?: string
    user?: { login?: string }
  }>(api, `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`)

  const parentIds = new Set(reviewComments.map((comment) => comment.in_reply_to_id).filter(Boolean))

  for (const comment of reviewComments) {
    if (comment.user?.login === botLogin && !parentIds.has(comment.id)) {
      await api(`/repos/${owner}/${repo}/pulls/comments/${comment.id}`, { method: "DELETE" })
    }
  }

  for (const comment of issueComments) {
    if (comment.user?.login === botLogin) {
      await api(`/repos/${owner}/${repo}/issues/comments/${comment.id}`, { method: "DELETE" })
    }
  }

  for (const review of reviews) {
    if (review.user?.login === botLogin && review.state === "CHANGES_REQUESTED") {
      await api(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${review.id}/dismissals`, {
        method: "PUT",
        body: JSON.stringify({ message: "All previous issues appear to be addressed." }),
      })
    }
  }
}

async function getPaginatedGithubCollection<T>(
  api: ReturnType<typeof createGithubApi>,
  path: string,
): Promise<T[]> {
  const pageSize = 100
  const items: T[] = []

  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?"
    const pageItems = ((await api(`${path}${separator}per_page=${pageSize}&page=${page}`)) as T[] | null) ?? []
    items.push(...pageItems)

    if (pageItems.length < pageSize) {
      return items
    }
  }
}

async function getLatestCommitSha(
  api: ReturnType<typeof createGithubApi>,
  owner: string,
  repo: string,
  prNumber: string,
): Promise<string> {
  const pullRequest = (await api(`/repos/${owner}/${repo}/pulls/${prNumber}`)) as {
    head?: { sha?: string }
  } | null
  const headSha = pullRequest?.head?.sha

  if (!headSha) {
    throw new Error("GitHub PR has no commits.")
  }

  return headSha
}

async function tryApprovePullRequest(
  api: ReturnType<typeof createGithubApi>,
  owner: string,
  repo: string,
  prNumber: string,
): Promise<void> {
  const [currentUser, pullRequest] = await Promise.all([
    getCurrentGithubUser(api),
    getPullRequest(api, owner, repo, prNumber),
  ])

  const prAuthor = pullRequest.user?.login
  if (currentUser && prAuthor && currentUser === prAuthor) {
    logger.warn(`Skipping GitHub auto-approval because the authenticated reviewer ${currentUser} is the PR author.`)
    return
  }

  try {
    await api(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event: "APPROVE" }),
    })
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 403 || error.status === 422)) {
      logger.warn(`GitHub auto-approval was skipped: ${formatGithubApprovalFailure(error.responseBody)}`)
      return
    }

    throw error
  }
}

async function getCurrentGithubUser(api: ReturnType<typeof createGithubApi>): Promise<string | null> {
  const user = (await api("/user")) as { login?: string } | null
  return user?.login ?? null
}

async function getPullRequest(
  api: ReturnType<typeof createGithubApi>,
  owner: string,
  repo: string,
  prNumber: string,
): Promise<{ head?: { sha?: string }; user?: { login?: string } }> {
  return ((await api(`/repos/${owner}/${repo}/pulls/${prNumber}`)) as {
    head?: { sha?: string }
    user?: { login?: string }
  } | null) ?? {}
}

function formatGithubApprovalFailure(responseBody: string): string {
  try {
    const parsed = JSON.parse(responseBody) as { message?: string; errors?: Array<{ message?: string }> }
    const messages = [parsed.message, ...(parsed.errors ?? []).map((error) => error.message)].filter(Boolean)
    if (messages.length > 0) {
      return messages.join("; ")
    }
  } catch {
    // Fall back to the raw response body when GitHub does not return JSON.
  }

  return responseBody || "GitHub rejected the approval review."
}

function buildSummaryComment(allIssues: CodeIssue[]): string {
  const counts = new Map<string, number>()
  for (const issue of allIssues) {
    counts.set(issue.issueType, (counts.get(issue.issueType) ?? 0) + 1)
  }

  const lines = [
    "### AI Code Review Summary",
    "",
    `Found **${allIssues.length} potential issue(s)** that may require attention.`,
    "",
    "**Issue Breakdown:**",
    ...[...counts.entries()].map(([type, count]) => `* **${type}:** ${count} issue(s)`),
    "",
    "---",
    "Please see the detailed inline comments below.",
  ]

  return lines.join("\n")
}

function buildIssueComment(issue: CodeIssue): string {
  const suggestion = issue.suggestion ? `\n\n\`\`\`suggestion\n${issue.suggestion}\n\`\`\`` : ""
  return `**[${issue.issueType}]**\n\n${issue.comment}${suggestion}`
}
