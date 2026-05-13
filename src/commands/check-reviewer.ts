import path from "node:path"

import { loadRawConfig } from "../config/load-config.js"
import { configureLogger, logger } from "../core/logger.js"
import { reviewIssuesEnvelopeSchema } from "../core/models.js"
import { createSessionClient } from "../opencode/client.js"
import { buildStructuredOutputInstructions, parseStructuredOutputOrNull } from "../opencode/structured-output.js"

export interface CheckReviewerCommandOptions {
  repoPath: string
  trace: boolean
}

export async function runCheckReviewerCommand(options: CheckReviewerCommandOptions): Promise<void> {
  configureLogger(options.trace)

  const repoPath = path.resolve(options.repoPath)
  const rawConfig = await loadRawConfig(repoPath)
  const client = await createSessionClient(rawConfig)

  try {
    const sessionId = await client.createSession("reviewer-check")
    const responseText = await client.promptText(sessionId, {
      agent: "reviewer",
      prompt: buildReviewerCheckPrompt(),
    })

    const result = parseStructuredOutputOrNull(responseText, reviewIssuesEnvelopeSchema)
    if (!result) {
      throw new Error(`Reviewer returned unparseable structured output: ${truncateResponse(responseText)}`)
    }

    logger.info("Reviewer connectivity check passed.")
    logger.info(`Repo: ${repoPath}`)
    logger.info(`Issues returned: ${result.issues.length}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Reviewer connectivity check failed: ${message}`)
  } finally {
    client.close()
  }
}

function truncateResponse(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`
}

function buildReviewerCheckPrompt(): string {
  return [
    buildStructuredOutputInstructions("Return a single JSON object with an issues array.", reviewIssuesEnvelopeSchema),
    "This is a reviewer connectivity and auth smoke test.",
    "Do not inspect the repository.",
    "Do not call tools.",
    "Return an empty issues array.",
  ].join("\n\n")
}
