import type { ChangedFileMap, IssueType, ReviewResult } from "../core/models.js"
import { reviewIssuesEnvelopeJsonSchema, reviewIssuesEnvelopeSchema } from "../core/models.js"
import type { OpencodeSessionClient } from "../opencode/client.js"

export const preferredReviewAgent = "reviewer"
export const fallbackReviewAgent = "general"

export const reviewerSystemPrompt = [
  "You are a ready-to-use code reviewer.",
  "",
  "Review only the provided change scope and report only concrete, high-confidence issues in the changed behavior.",
  "",
  "Rules:",
  "- Use available tools to inspect repository context as needed.",
  "- Do not modify files.",
  "- Stay within the provided review scope.",
  "- Use `git diff`, `git log`, `git show`, and `git status` only for inspection.",
  "- Focus on bugs, regressions, security problems, performance risks, and missing test coverage for new logic.",
  "- Comment only when there is enough evidence in the diff and inspected repository context.",
  "- Do not report compiler, linter, formatting, or speculative issues.",
  "- Prefer fewer, stronger findings over many weak comments.",
  "- Scope each finding to a changed file and use the new line number.",
  "- Return issues only.",
  "",
  "When project-specific rules are provided, apply them in addition to the rules above.",
  "",
  "Return only structured JSON.",
].join("\n")

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

export interface ResolvedReviewAgent {
  name: string
  system?: string
  availableAgents: string[]
  fallbackUsed: boolean
  discoveryFailed: boolean
}

export async function runReview(client: OpencodeSessionClient, input: RunReviewInput): Promise<Record<string, ReviewResult>> {
  const resolvedAgent = await resolveReviewAgent(client)
  const envelope = reviewIssuesEnvelopeSchema.parse(await collectReviewIssues(client, input, resolvedAgent))

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

async function collectReviewIssues(
  client: OpencodeSessionClient,
  input: RunReviewInput,
  resolvedAgent: ResolvedReviewAgent,
): Promise<unknown> {
  const sessionId = await client.createSession("reviewer")

  try {
    const prompt = buildReviewPrompt(input)
    return await promptReviewIssues(client, sessionId, prompt, resolvedAgent)
  } catch (error) {
    if (!shouldRetryReviewInSmallerBatches(error) || Object.keys(input.changedFilesMap).length < 2) {
      throw error
    }
  }

  const [leftChangedFilesMap, rightChangedFilesMap] = splitChangedFilesMap(input.changedFilesMap)
  const leftEnvelope = reviewIssuesEnvelopeSchema.parse(await collectReviewIssues(client, {
    ...input,
    changedFilesMap: leftChangedFilesMap,
  }, resolvedAgent))
  const rightEnvelope = reviewIssuesEnvelopeSchema.parse(await collectReviewIssues(client, {
    ...input,
    changedFilesMap: rightChangedFilesMap,
  }, resolvedAgent))

  return {
    issues: [...leftEnvelope.issues, ...rightEnvelope.issues],
  }
}

export async function resolveReviewAgent(client: OpencodeSessionClient): Promise<ResolvedReviewAgent> {
  let availableAgents: string[]

  try {
    availableAgents = await client.listAgents()
  } catch {
    return {
      name: preferredReviewAgent,
      availableAgents: [],
      fallbackUsed: false,
      discoveryFailed: true,
    }
  }

  if (availableAgents.includes(preferredReviewAgent)) {
    return {
      name: preferredReviewAgent,
      availableAgents,
      fallbackUsed: false,
      discoveryFailed: false,
    }
  }

  if (availableAgents.includes(fallbackReviewAgent)) {
    return {
      name: fallbackReviewAgent,
      system: reviewerSystemPrompt,
      availableAgents,
      fallbackUsed: true,
      discoveryFailed: false,
    }
  }

  const listedAgents = availableAgents.length > 0 ? availableAgents.join(", ") : "none"
  throw new Error(
    `OpenCode did not expose the required review agents. Missing "${preferredReviewAgent}" and fallback "${fallbackReviewAgent}". Available agents: ${listedAgents}`,
  )
}

async function promptReviewIssues(
  client: OpencodeSessionClient,
  sessionId: string,
  prompt: string,
  resolvedAgent: ResolvedReviewAgent,
): Promise<unknown> {
  try {
    return await client.promptStructured(sessionId, {
      agent: resolvedAgent.name,
      system: resolvedAgent.system,
      prompt,
      schema: reviewIssuesEnvelopeJsonSchema,
      retryCount: 5,
    })
  } catch (error) {
    if (!resolvedAgent.discoveryFailed || !isMissingAgentError(error)) {
      throw error
    }

    return await client.promptStructured(sessionId, {
      agent: fallbackReviewAgent,
      system: reviewerSystemPrompt,
      prompt,
      schema: reviewIssuesEnvelopeJsonSchema,
      retryCount: 5,
    })
  }
}

export function isMissingAgentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("Agent not found")
}

function shouldRetryReviewInSmallerBatches(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("structured output")
}

function splitChangedFilesMap(changedFilesMap: ChangedFileMap): [ChangedFileMap, ChangedFileMap] {
  const entries = Object.entries(changedFilesMap)
  const midpoint = Math.ceil(entries.length / 2)

  return [
    Object.fromEntries(entries.slice(0, midpoint)),
    Object.fromEntries(entries.slice(midpoint)),
  ]
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
