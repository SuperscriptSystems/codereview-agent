import { execa } from "execa"

import { logger } from "../core/logger.js"
import type { ChangedFileMap, FileContentMap } from "../core/models.js"
import { parseChangedFilesFromDiff } from "./parse.js"
import { getFileContent } from "./files.js"

export async function getDiff(repoPath: string, baseRef: string, headRef: string): Promise<string> {
  const mergeBase = await tryGetMergeBase(repoPath, baseRef, headRef)
  const diffBase = mergeBase ?? baseRef
  const result = await execa("git", ["diff", diffBase, headRef], { cwd: repoPath })
  return result.stdout
}

export async function getCommitMessages(repoPath: string, baseRef: string, headRef: string): Promise<string> {
  try {
    const result = await execa("git", ["log", `${baseRef}..${headRef}`, "--pretty=%B"], { cwd: repoPath })
    return result.stdout.trim()
  } catch (error) {
    logger.debug(error instanceof Error ? error.message : String(error))
    return `Could not find commits between ${baseRef} and ${headRef}`
  }
}

export async function getRecentCommitMessages(repoPath: string, limit = 10): Promise<string> {
  try {
    const result = await execa("git", ["log", "-n", String(limit), "--pretty=%B"], { cwd: repoPath })
    return result.stdout.trim()
  } catch (error) {
    logger.debug(error instanceof Error ? error.message : String(error))
    return ""
  }
}

export async function getStructuredDiffSummary(
  repoPath: string,
  baseRef: string,
  headRef: string,
): Promise<Record<string, unknown>> {
  try {
    const mergeBase = await tryGetMergeBase(repoPath, baseRef, headRef)
    const diffBase = mergeBase ?? baseRef
    const result = await execa("git", ["diff", diffBase, headRef, "--numstat"], { cwd: repoPath })
    const filesChanged = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [insertions, deletions, filePath] = line.split("\t")
        return {
          path: filePath,
          insertions: Number.parseInt(insertions ?? "0", 10) || 0,
          deletions: Number.parseInt(deletions ?? "0", 10) || 0,
        }
      })

    return { files_changed: filesChanged }
  } catch (error) {
    logger.debug(error instanceof Error ? error.message : String(error))
    return { error: "Could not generate summary." }
  }
}

export async function getStagedDiffContent(
  repoPath: string,
): Promise<{ changedFilesMap: ChangedFileMap; changedFilesContent: FileContentMap }> {
  const diffResult = await execa("git", ["diff", "--cached", "--no-ext-diff"], { cwd: repoPath })
  const changedFilesMap = parseChangedFilesFromDiff(diffResult.stdout)

  const changedFilesContentEntries = await Promise.all(
    Object.keys(changedFilesMap).map(async (filePath) => [filePath, await getFileContent(repoPath, filePath)] as const),
  )

  return {
    changedFilesMap,
    changedFilesContent: Object.fromEntries(changedFilesContentEntries),
  }
}

async function tryGetMergeBase(repoPath: string, baseRef: string, headRef: string): Promise<string | null> {
  try {
    const result = await execa("git", ["merge-base", baseRef, headRef], { cwd: repoPath })
    return result.stdout.trim() || null
  } catch (error) {
    logger.debug(error instanceof Error ? error.message : String(error))
    return null
  }
}
