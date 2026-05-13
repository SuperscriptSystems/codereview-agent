import path from "node:path"

import { loadRawConfig, parseConfig } from "../config/load-config.js"
import { configureLogger, logger } from "../core/logger.js"
import { getCommitMessages, getStructuredDiffSummary } from "../git/diff.js"
import { getTaskIdFromGitInfo } from "../git/context.js"
import { addAssessmentComment, buildJiraDetailsText, getTaskDetails, projectKeys } from "../integrations/jira.js"
import { createSessionClient } from "../opencode/client.js"
import { summarizeChangesForJira } from "../review/summarizer.js"

export interface AssessCommandOptions {
  repoPath: string
  baseRef: string
  headRef: string
  trace: boolean
}

export async function runAssessCommand(options: AssessCommandOptions): Promise<void> {
  configureLogger(options.trace)

  const repoPath = path.resolve(options.repoPath)
  const rawConfig = await loadRawConfig(repoPath)
  parseConfig(rawConfig)

  if (!process.env.JIRA_URL) {
    logger.info("Jira integration is not configured. Skipping assessment.")
    return
  }

  const commitMessages = await getCommitMessages(repoPath, options.baseRef, options.headRef)
  let taskId = process.env.JIRA_TASK_ID ?? (await getTaskIdFromGitInfo(repoPath, commitMessages))

  if (!taskId) {
    logger.info("No Jira task ID found; skipping assessment.")
    return
  }

  const knownPrefixes = await projectKeys()
  if (knownPrefixes.size > 0) {
    const prefix = taskId.split("-")[0]
    if (!knownPrefixes.has(prefix)) {
      logger.warn(`Extracted task '${taskId}' has unknown project prefix '${prefix}'.`)
      return
    }
  }

  const taskDetails = await getTaskDetails(taskId)
  if (!taskDetails) {
    logger.warn(`Could not fetch Jira details for ${taskId}. Skipping assessment.`)
    return
  }

  const jiraDetails = buildJiraDetailsText(taskId, taskDetails)
  const diffSummary = await getStructuredDiffSummary(repoPath, options.baseRef, options.headRef)
  if ("error" in diffSummary) {
    logger.error("Failed to generate structured diff summary. Skipping Jira assessment.")
    return
  }

  const client = await createSessionClient(rawConfig, repoPath)

  try {
    const summary = await summarizeChangesForJira(client, {
      jiraDetails,
      commitMessages,
      diffSummary,
    })

    if (!summary) {
      logger.warn("Summarizer did not produce a valid result. Skipping Jira comment.")
      return
    }

    await addAssessmentComment(taskId, summary)
    logger.info(`Jira assessment comment posted for ${taskId}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Assess execution failed: ${message}`)
  } finally {
    client.close()
  }

  logger.info(`Repo: ${repoPath}`)
  logger.info(`Range: ${options.baseRef}..${options.headRef}`)
}
