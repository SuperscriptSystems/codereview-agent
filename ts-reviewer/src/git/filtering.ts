import path from "node:path"

import type { ChangedFileMap, FilteringConfig } from "../core/models.js"

export function filterTestFiles(changedFilesMap: ChangedFileMap, testKeywords: string[]): ChangedFileMap {
  const keywords = new Set(testKeywords.map((keyword) => keyword.toLowerCase()))
  const filtered: ChangedFileMap = {}

  for (const [filePath, diff] of Object.entries(changedFilesMap)) {
    const parts = path
      .normalize(filePath)
      .split(path.sep)
      .map((part) => part.toLowerCase())

    if (!parts.some((part) => keywords.has(part))) {
      filtered[filePath] = diff
    }
  }

  return filtered
}

export function filterFilesByPattern(changedFilesMap: ChangedFileMap, ignoredPatterns: string[]): ChangedFileMap {
  if (ignoredPatterns.length === 0) {
    return changedFilesMap
  }

  const filtered: ChangedFileMap = {}

  for (const [filePath, diff] of Object.entries(changedFilesMap)) {
    const filename = path.basename(filePath)

    if (!ignoredPatterns.some((pattern) => filename.includes(pattern))) {
      filtered[filePath] = diff
    }
  }

  return filtered
}

export function shouldIgnorePath(filePath: string, filtering: FilteringConfig): boolean {
  const normalizedPath = filePath.replaceAll("\\", "/")
  const pathParts = normalizedPath.split("/")
  const extension = path.extname(normalizedPath)
  const filename = path.basename(normalizedPath)

  return (
    filtering.ignoredExtensions.includes(extension) ||
    pathParts.some((part) => filtering.ignoredPaths.includes(part)) ||
    filtering.ignoredPatterns.some((pattern) => filename.includes(pattern))
  )
}
