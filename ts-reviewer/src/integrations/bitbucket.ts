import type { CodeIssue } from "../core/models.js"
import { logger } from "../core/logger.js"

export async function cleanupAndPostAllComments(
  allIssues: CodeIssue[],
  filesWithIssues: Record<string, CodeIssue[]>,
): Promise<void> {
  const username = process.env.BITBUCKET_APP_USERNAME
  const password = process.env.BITBUCKET_APP_PASSWORD
  const workspace = process.env.BITBUCKET_WORKSPACE
  const repoSlug = process.env.BITBUCKET_REPO_SLUG
  const prId = process.env.BITBUCKET_PR_ID

  if (!username || !password || !workspace || !repoSlug || !prId) {
    throw new Error("Bitbucket PR environment is not fully configured.")
  }

  const auth = Buffer.from(`${username}:${password}`).toString("base64")
  const api = async (path: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetch(`https://api.bitbucket.org/2.0${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    })

    if (!response.ok && response.status !== 404) {
      const body = await response.text()
      throw new Error(`Bitbucket API ${path} failed: ${response.status} ${body}`)
    }

    if (response.status === 204) {
      return null
    }

    const text = await response.text()
    return text ? (JSON.parse(text) as unknown) : null
  }

  const basePath = `/repositories/${workspace}/${repoSlug}/pullrequests/${prId}`
  const me = (await api(`/user`)) as { account_id?: string } | null
  const accountId = me?.account_id
  await cleanupBotComments(api, `${basePath}/comments`, accountId)

  if (allIssues.length === 0) {
    await api(`${basePath}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: { raw: "Excellent work! The AI agent didn't find any issues. Keep up the great contributions!" } }),
    })
    await api(`${basePath}/approve`, { method: "POST" })
    return
  }

  await api(`${basePath}/approve`, { method: "DELETE" })

  for (const [filePath, issues] of Object.entries(filesWithIssues)) {
    for (const issue of issues) {
      await api(`${basePath}/comments`, {
        method: "POST",
        body: JSON.stringify({
          content: { raw: buildBitbucketIssueComment(issue) },
          inline: { path: filePath, to: issue.lineNumber },
        }),
      })
    }
  }

  await api(`${basePath}/comments`, {
    method: "POST",
    body: JSON.stringify({ content: { raw: buildBitbucketSummary(allIssues) } }),
  })
}

async function cleanupBotComments(
  api: (path: string, init?: RequestInit) => Promise<unknown>,
  commentsPath: string,
  accountId: string | undefined,
): Promise<void> {
  logger.info("Cleaning previous Bitbucket bot comments.")

  const data = (await api(commentsPath)) as {
    values?: Array<{ id: number; user?: { account_id?: string }; parent?: { id?: number } }>
    next?: string
  } | null
  const comments = data?.values ?? []
  const parentIds = new Set(comments.map((comment) => comment.parent?.id).filter(Boolean))

  for (const comment of comments) {
    if (comment.user?.account_id === accountId && !parentIds.has(comment.id)) {
      await api(`${commentsPath}/${comment.id}`, { method: "DELETE" })
    }
  }
}

function buildBitbucketIssueComment(issue: CodeIssue): string {
  const suggestion = issue.suggestion ? `\n\n**Suggestion:**\n\`\`\`\n${issue.suggestion}\n\`\`\`` : ""
  return `**[${issue.issueType}]**\n\n${issue.comment}${suggestion}`
}

function buildBitbucketSummary(allIssues: CodeIssue[]): string {
  const counts = new Map<string, number>()
  for (const issue of allIssues) {
    counts.set(issue.issueType, (counts.get(issue.issueType) ?? 0) + 1)
  }

  const lines = [
    "### AI Code Review Summary",
    "",
    `Found **${allIssues.length} potential issue(s)**.`,
    "",
    "**Issue Breakdown:**",
    ...[...counts.entries()].map(([type, count]) => `* **${type}:** ${count} issue(s)`),
    "",
    "---",
    "Please see the detailed inline comments on the Diff tab for more context.",
  ]

  return lines.join("\n")
}
