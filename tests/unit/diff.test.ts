import { describe, expect, it, vi } from "vitest"

const execaMock = vi.fn()

vi.mock("execa", () => ({
  execa: execaMock,
}))

const { getStructuredDiffSummary } = await import("../../src/git/diff.js")

describe("git diff helpers", () => {
  it("uses merge-base for structured diff summaries", async () => {
    execaMock
      .mockResolvedValueOnce({ stdout: "merge-base-sha" })
      .mockResolvedValueOnce({ stdout: "5\t1\tsrc/main.ts" })

    const summary = await getStructuredDiffSummary("/repo", "origin/main", "HEAD")

    expect(execaMock).toHaveBeenNthCalledWith(1, "git", ["merge-base", "origin/main", "HEAD"], { cwd: "/repo" })
    expect(execaMock).toHaveBeenNthCalledWith(2, "git", ["diff", "merge-base-sha", "HEAD", "--numstat"], { cwd: "/repo" })
    expect(summary).toEqual({
      files_changed: [{ path: "src/main.ts", insertions: 5, deletions: 1 }],
    })
  })
})
