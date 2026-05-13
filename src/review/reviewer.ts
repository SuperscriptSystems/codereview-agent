import type { ChangedFileMap, IssueType, ReviewResult } from "../core/models.js"
import { reviewIssuesEnvelopeJsonSchema, reviewIssuesEnvelopeSchema } from "../core/models.js"
import type { OpencodeSessionClient } from "../opencode/client.js"

export interface RunReviewInput {
  repoPath: string
  staged: boolean
  baseRef: string
  headRef: string
  changedFilesMap: ChangedFileMap
  commitMessages: string
  jiraDetails: string
  reviewRules: string[]
  focusAreas: IssueType[]
}

export async function runReview(client: OpencodeSessionClient, input: RunReviewInput): Promise<Record<string, ReviewResult>> {
  const sessionId = await client.createSession("reviewer")
  const prompt = buildReviewPrompt(input)
  const envelope = reviewIssuesEnvelopeSchema.parse(await client.promptStructured(sessionId, {
    agent: "reviewer",
    prompt,
    schema: reviewIssuesEnvelopeJsonSchema,
  }))

  const issuesByFile = new Map<string, ReviewResult["issues"]>()

  for (const issue of envelope.issues) {
    if (!input.changedFilesMap[issue.filePath]) {
      continue
    }

    const existing = issuesByFile.get(issue.filePath) ?? []
    existing.push(issue)
    issuesByFile.set(issue.filePath, existing)
  }

  return Object.fromEntries(
    Object.keys(input.changedFilesMap).map((filePath) => [filePath, { issues: issuesByFile.get(filePath) ?? [] }]),
  )
}

export function buildReviewPrompt(input: RunReviewInput): string {
  const customRules = input.reviewRules.length > 0 ? `Custom rules:\n- ${input.reviewRules.join("\n- ")}` : "Custom rules:\n- None"
  const fullDiff = Object.entries(input.changedFilesMap)
    .map(([filePath, diff]) => `--- ${filePath} ---\n${diff}`)
    .join("\n")
  const changedFiles = Object.keys(input.changedFilesMap)
    .map((filePath) => `- ${filePath}`)
    .join("\n")
  const jiraContext = input.jiraDetails.trim() || "Jira context:\nNone"
  const commitMessages = input.commitMessages.trim() || "No commit messages provided."
  const scopeMode = input.staged ? "staged" : `${input.baseRef}..${input.headRef}`

  return [
    "Review mode: tool-driven repository inspection.",
    `Repository path: ${input.repoPath}`,
    `Scope mode: ${scopeMode}`,
    "Use your tools to inspect any needed files, symbols, and surrounding repository context.",
    "Do not edit files.",
    "Return a JSON object matching the provided schema.",
    "Return issues only for files in the provided change scope.",
    `Allowed issue types: ${input.focusAreas.join(", ")}`,
    "Changed files:",
    changedFiles,
    "Commit messages:",
    commitMessages,
    jiraContext,
    customRules,
    "Git Diff:",
    fullDiff,
  ].join("\n\n")
}
