import path from "node:path"

import { loadRawConfig } from "../config/load-config.js"
import { configureLogger, logger } from "../core/logger.js"
import { reviewIssuesEnvelopeJsonSchema, reviewIssuesEnvelopeSchema } from "../core/models.js"
import { createSessionClient } from "../opencode/client.js"

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
    const result = reviewIssuesEnvelopeSchema.parse(await client.promptStructured(sessionId, {
      agent: "reviewer",
      prompt: buildReviewerCheckPrompt(),
      schema: reviewIssuesEnvelopeJsonSchema,
    }))

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

function buildReviewerCheckPrompt(): string {
  return [
    "This is a reviewer connectivity and auth smoke test.",
    "Do not inspect the repository.",
    "Do not call tools.",
    "Return a JSON object matching the provided schema.",
    "Return an empty issues array.",
  ].join("\n\n")
}
