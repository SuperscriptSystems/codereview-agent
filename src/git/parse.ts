import type { ChangedFileMap } from "../core/models.js"

export function parseChangedFilesFromDiff(diffText: string): ChangedFileMap {
  const lines = diffText.split(/\r?\n/)
  const changedFilesMap: ChangedFileMap = {}

  let currentFilePath: string | null = null
  let currentFileLines: string[] = []

  const flush = (): void => {
    if (!currentFilePath) {
      return
    }

    changedFilesMap[currentFilePath] = currentFileLines.join("\n").trim()
    currentFilePath = null
    currentFileLines = []
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush()
      currentFileLines = [line]
      continue
    }

    if (line.startsWith("+++ b/")) {
      currentFilePath = line.slice(6)
    }

    if (currentFileLines.length > 0) {
      currentFileLines.push(line)
    }
  }

  flush()
  return changedFilesMap
}
