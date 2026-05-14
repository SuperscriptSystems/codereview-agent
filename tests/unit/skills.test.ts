import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { loadProjectSkillPaths } from "../../src/review/skills.js"

const tempDirs: string[] = []

describe("loadProjectSkillPaths", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directoryPath) => rm(directoryPath, { recursive: true, force: true })))
  })

  it("returns an empty array when no .agents/skills directory exists", async () => {
    const repoPath = await createTempRepo()

    await expect(loadProjectSkillPaths(repoPath)).resolves.toEqual([])
  })

  it("returns one repo-relative markdown path", async () => {
    const repoPath = await createTempRepo()
    await writeRepoFile(repoPath, ".agents/skills/frontend-design/skills.md")

    await expect(loadProjectSkillPaths(repoPath)).resolves.toEqual([
      ".agents/skills/frontend-design/skills.md",
    ])
  })

  it("supports nested markdown files in subfolders", async () => {
    const repoPath = await createTempRepo()
    await writeRepoFile(repoPath, ".agents/skills/react/forms.md")
    await writeRepoFile(repoPath, ".agents/skills/frontend-design/mobile/skills.md")

    await expect(loadProjectSkillPaths(repoPath)).resolves.toEqual([
      ".agents/skills/frontend-design/mobile/skills.md",
      ".agents/skills/react/forms.md",
    ])
  })

  it("ignores non-markdown files", async () => {
    const repoPath = await createTempRepo()
    await writeRepoFile(repoPath, ".agents/skills/frontend-design/skills.txt")
    await writeRepoFile(repoPath, ".agents/skills/frontend-design/skills.md")

    await expect(loadProjectSkillPaths(repoPath)).resolves.toEqual([
      ".agents/skills/frontend-design/skills.md",
    ])
  })

  it("returns stable sorted repo-relative paths", async () => {
    const repoPath = await createTempRepo()
    await writeRepoFile(repoPath, ".agents/skills/zeta/skills.md")
    await writeRepoFile(repoPath, ".agents/skills/alpha/guide.md")
    await writeRepoFile(repoPath, ".agents/skills/alpha/deep/rules.md")

    await expect(loadProjectSkillPaths(repoPath)).resolves.toEqual([
      ".agents/skills/alpha/deep/rules.md",
      ".agents/skills/alpha/guide.md",
      ".agents/skills/zeta/skills.md",
    ])
  })
})

async function createTempRepo(): Promise<string> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "review-skills-"))
  tempDirs.push(repoPath)
  return repoPath
}

async function writeRepoFile(repoPath: string, relativePath: string): Promise<void> {
  const filePath = path.join(repoPath, relativePath)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, "placeholder\n", "utf8")
}
