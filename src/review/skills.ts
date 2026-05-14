import { readdir } from "node:fs/promises"
import path from "node:path"

export async function loadProjectSkillPaths(repoPath: string): Promise<string[]> {
  const skillsRoot = path.join(repoPath, ".agents", "skills")
  const entries = await collectMarkdownFiles(skillsRoot)

  return entries
    .map((filePath) => normalizeToRepoPath(repoPath, filePath))
    .sort((left, right) => left.localeCompare(right))
}

async function collectMarkdownFiles(directoryPath: string): Promise<string[]> {
  let entries

  try {
    entries = await readdir(directoryPath, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []
    }

    throw error
  }

  const markdownFiles: string[] = []

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name)

    if (entry.isDirectory()) {
      markdownFiles.push(...await collectMarkdownFiles(entryPath))
      continue
    }

    if (entry.isFile() && entry.name.endsWith(".md")) {
      markdownFiles.push(entryPath)
    }
  }

  return markdownFiles
}

function normalizeToRepoPath(repoPath: string, filePath: string): string {
  return path.relative(repoPath, filePath).split(path.sep).join("/")
}
