import path from "node:path"

import { loadConfig, loadRawConfig } from "../config/load-config.js"
import { configureLogger, logger } from "../core/logger.js"
import type { IssueType } from "../core/models.js"
import { getCommitMessages, getDiff, getStagedDiffContent } from "../git/diff.js"
import { filterFilesByPattern, filterTestFiles } from "../git/filtering.js"
import { parseChangedFilesFromDiff } from "../git/parse.js"
import { cleanupAndPostAllComments } from "../integrations/bitbucket.js"
import { handlePrResults } from "../integrations/github.js"
import { createSessionClient } from "../opencode/client.js"
import { runReview } from "../review/reviewer.js"

export interface ReviewCommandOptions {
  repoPath: string
  baseRef: string
  headRef: string
  staged: boolean
  focus?: string[]
  trace: boolean
}

export async function runReviewCommand(options: ReviewCommandOptions): Promise<void> {
  configureLogger(options.trace)

  const repoPath = path.resolve(options.repoPath)
  const rawConfig = await loadRawConfig(repoPath)
  const config = await loadConfig(repoPath)

  const focusAreas = resolveFocusAreas(options.focus, config.review.focusAreas)
  const filtering = config.review.filtering

  const { changedFilesMap, commitMessages } = await collectReviewInputs(repoPath, options)

  if (Object.keys(changedFilesMap).length === 0) {
    logger.info("No changed files detected to review.")
    return
  }

  let filteredChangedFilesMap = filterTestFiles(changedFilesMap, config.review.testKeywords)
  filteredChangedFilesMap = filterFilesByPattern(filteredChangedFilesMap, filtering.ignoredPatterns)

  if (Object.keys(filteredChangedFilesMap).length === 0) {
    logger.info("No non-test files remain after filtering.")
    return
  }

  logger.info(`Repo: ${repoPath}`)
  logger.info(`Mode: ${options.staged ? "staged" : `${options.baseRef}..${options.headRef}`}`)
  logger.info(`Changed files: ${Object.keys(changedFilesMap).length}`)
  logger.info(`Files after filtering: ${Object.keys(filteredChangedFilesMap).length}`)
  logger.info(`Focus: ${focusAreas.join(", ")}`)
  logger.info(`Custom rules: ${config.review.customRules.length}`)

  const sessionClient = await createSessionClient(rawConfig, repoPath)

  try {
    const reviewResults = await runReview(sessionClient, {
      repoPath,
      staged: options.staged,
      baseRef: options.baseRef,
      headRef: options.headRef,
      changedFilesMap: filteredChangedFilesMap,
      commitMessages,
      jiraDetails: "",
      reviewRules: config.review.customRules,
      focusAreas,
    })

    const issueCount = Object.values(reviewResults).reduce((count, result) => count + result.issues.length, 0)
    const filesWithIssues = Object.fromEntries(
      Object.entries(reviewResults)
        .filter(([, result]) => result.issues.length > 0)
        .map(([filePath, result]) => [filePath, result.issues]),
    )
    const allIssues = Object.values(reviewResults).flatMap((result) => result.issues)

    if (isGithubPr()) {
      await handlePrResults(allIssues, filesWithIssues)
    } else if (isBitbucketPr()) {
      await cleanupAndPostAllComments(allIssues, filesWithIssues)
    }

    if (issueCount === 0) {
      logger.info("No issues found.")
      return
    }

    for (const [filePath, issues] of Object.entries(filesWithIssues)) {
      if (issues.length === 0) {
        continue
      }

      logger.info(`Issues in ${filePath}:`)
      for (const issue of issues) {
        logger.info(`  L${issue.lineNumber} [${issue.issueType}] ${issue.comment}`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`OpenCode review execution failed: ${message}`)
    logger.error("Verify OpenCode provider auth and model configuration before running the full review flow.")
  } finally {
    sessionClient.close()
  }
}

function isGithubPr(): boolean {
  return Boolean(process.env.GITHUB_ACTIONS && process.env.GITHUB_PR_NUMBER)
}

function isBitbucketPr(): boolean {
  return Boolean(process.env.BITBUCKET_PR_ID)
}

function resolveFocusAreas(cliFocus: string[] | undefined, configFocus: IssueType[]): IssueType[] {
  if (!cliFocus || cliFocus.length === 0) {
    return configFocus
  }

  const allowed = new Set<IssueType>([
    "LogicError",
    "CodeStyle",
    "Security",
    "Suggestion",
    "TestCoverage",
    "Clarity",
    "Performance",
    "Other",
  ])

  const normalized = cliFocus
    .map((value) => [...allowed].find((candidate) => candidate.toLowerCase() === value.toLowerCase()))
    .filter((value): value is IssueType => Boolean(value))

  return normalized.length > 0 ? normalized : configFocus
}

async function collectReviewInputs(
  repoPath: string,
  options: ReviewCommandOptions,
): Promise<{
  changedFilesMap: Record<string, string>
  commitMessages: string
}> {
  if (options.staged) {
    const staged = await getStagedDiffContent(repoPath)
    return {
      changedFilesMap: staged.changedFilesMap,
      commitMessages: "Reviewing staged files before commit.",
    }
  }

  const diff = await getDiff(repoPath, options.baseRef, options.headRef)
  return {
    changedFilesMap: parseChangedFilesFromDiff(diff),
    commitMessages: await getCommitMessages(repoPath, options.baseRef, options.headRef),
  }
}
