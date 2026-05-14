import path from "node:path"

import { loadRawConfig } from "../config/load-config.js"
import { configureLogger, logger } from "../core/logger.js"
import { reviewIssuesEnvelopeJsonSchema, reviewIssuesEnvelopeSchema } from "../core/models.js"
import { createSessionClient } from "../opencode/client.js"
import { isMissingAgentError, resolveReviewAgent, reviewerSystemPrompt } from "../review/reviewer.js"

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
    const resolvedAgent = await resolveReviewAgent(client)
    const sessionId = await client.createSession("reviewer-check")
    const prompt = buildReviewerCheckPrompt()
    const checkResult = await promptReviewerCheck(client, sessionId, prompt, resolvedAgent)
    const result = reviewIssuesEnvelopeSchema.parse(checkResult.payload)

    if (resolvedAgent.fallbackUsed || checkResult.fallbackUsed) {
      logger.error(
        `Custom reviewer agent is unavailable. Fallback via 'general' succeeded, but reviewer registration is missing.${formatAvailableAgents(resolvedAgent.availableAgents)}`,
      )
      return
    }

    logger.info("Reviewer connectivity check passed.")
    logger.info(`Agent used: ${resolvedAgent.name}`)
    logger.info(`Repo: ${repoPath}`)
    logger.info(`Issues returned: ${result.issues.length}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Reviewer connectivity check failed: ${message}`)
  } finally {
    await client.close()
  }
}

async function promptReviewerCheck(
  client: Awaited<ReturnType<typeof createSessionClient>>,
  sessionId: string,
  prompt: string,
  resolvedAgent: Awaited<ReturnType<typeof resolveReviewAgent>>,
): Promise<{ payload: unknown; fallbackUsed: boolean }> {
  try {
    return {
      payload: await client.promptStructured(sessionId, {
        agent: resolvedAgent.name,
        system: resolvedAgent.system,
        prompt,
        schema: reviewIssuesEnvelopeJsonSchema,
      }),
      fallbackUsed: false,
    }
  } catch (error) {
    if (!resolvedAgent.discoveryFailed || !isMissingAgentError(error)) {
      throw error
    }

    return {
      payload: await client.promptStructured(sessionId, {
        agent: "general",
        system: reviewerSystemPrompt,
        prompt,
        schema: reviewIssuesEnvelopeJsonSchema,
      }),
      fallbackUsed: true,
    }
  }
}

function formatAvailableAgents(availableAgents: string[]): string {
  if (availableAgents.length === 0) {
    return ""
  }

  return ` Available agents: ${availableAgents.join(", ")}`
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
