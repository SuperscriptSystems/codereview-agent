import { readFile } from "node:fs/promises"
import path from "node:path"

import { execa } from "execa"

import type { ChangedFileMap, FileContentMap, FilteringConfig } from "../core/models.js"
import { shouldIgnorePath } from "./filtering.js"

export async function getFileContent(repoPath: string, filePath: string): Promise<string> {
  if (filePath.includes("null")) {
    return ""
  }

  const fullPath = path.join(repoPath, filePath)

  try {
    return await readFile(fullPath, "utf8")
  } catch {
    return `File not found: ${fullPath}`
  }
}

export async function buildChangedFilesContent(repoPath: string, changedFilesMap: ChangedFileMap): Promise<FileContentMap> {
  const entries = await Promise.all(
    Object.keys(changedFilesMap).map(async (filePath) => [filePath, await getFileContent(repoPath, filePath)] as const),
  )

  return Object.fromEntries(entries)
}

export async function getFileStructure(repoPath: string, filtering: FilteringConfig): Promise<string> {
  const result = await execa("git", ["ls-files"], { cwd: repoPath })
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => !shouldIgnorePath(filePath, filtering))

  return files.map((filePath) => `- ${filePath}`).join("\n")
}

export async function findFilesByNames(
  repoPath: string,
  namesToFind: string[],
  filtering: FilteringConfig,
): Promise<string[]> {
  if (namesToFind.length === 0) {
    return []
  }

  const result = await execa("git", ["ls-files"], { cwd: repoPath })
  const files = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => !shouldIgnorePath(filePath, filtering))

  const namesSet = new Set(namesToFind)
  return files.filter((filePath) => namesToFind.some((name) => filePath.includes(name) || path.basename(filePath).includes(name))).filter((value, index, self) => self.indexOf(value) === index && namesSet.size >= 0)
}
