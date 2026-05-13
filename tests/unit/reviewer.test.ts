import { describe, expect, it } from "vitest"

import { runReview, buildReviewPrompt, type RunReviewInput } from "../../src/review/reviewer.js"

describe("reviewer", () => {
  const input: RunReviewInput = {
    repoPath: "/repo",
    staged: false,
    baseRef: "origin/main",
    headRef: "HEAD",
    changedFilesMap: {
      "src/app.ts": "@@ -1,1 +1,1 @@\n-console.log('old')\n+console.log('new')",
    },
    commitMessages: "ABC-123 update app flow",
    jiraDetails: "Jira context:\nTask: ABC-123",
    reviewRules: ["Prefer guarding null inputs."],
    focusAreas: ["LogicError", "Security"],
  }

  it("builds a tool-driven prompt with diff and review metadata", () => {
    const prompt = buildReviewPrompt(input)

    expect(prompt).toContain("Scope mode: origin/main..HEAD")
    expect(prompt).toContain("Repository path: /repo")
    expect(prompt).toContain("Use your tools to inspect any needed files, symbols, and surrounding repository context.")
    expect(prompt).toContain("Do not edit files.")
    expect(prompt).toContain("Changed files:")
    expect(prompt).toContain("- src/app.ts")
    expect(prompt).toContain("Commit messages:")
    expect(prompt).toContain("ABC-123 update app flow")
    expect(prompt).toContain("Jira context:\nTask: ABC-123")
    expect(prompt).toContain("Custom rules:\n- Prefer guarding null inputs.")
    expect(prompt).toContain("Git Diff:")
    expect(prompt).toContain("--- src/app.ts ---")
    expect(prompt).not.toContain("Annotated Files:")
  })

  it("filters findings outside the changed file scope", async () => {
    const client = {
      createSession: async () => "session-1",
      promptText: async () => `BEGIN_JSON
{"issues":[{"filePath":"src/app.ts","lineNumber":10,"issueType":"LogicError","comment":"Real issue"},{"filePath":"src/other.ts","lineNumber":3,"issueType":"Security","comment":"Out of scope"}]}
END_JSON`,
      close: () => {},
    }

    const results = await runReview(client, input)

    expect(results).toEqual({
      "src/app.ts": {
        issues: [
          {
            filePath: "src/app.ts",
            lineNumber: 10,
            issueType: "LogicError",
            comment: "Real issue",
          },
        ],
      },
    })
  })

  it("fails when reviewer output cannot be parsed into structured issues", async () => {
    const client = {
      createSession: async () => "session-1",
      promptText: async () => "I found a couple of problems, but here they are in prose.",
      close: () => {},
    }

    await expect(runReview(client, input)).rejects.toThrow(/Reviewer returned unparseable structured output/)
  })

  it("no longer depends on annotated file assembly", async () => {
    const reviewerSource = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../../src/review/reviewer.ts", import.meta.url), "utf8"),
    )

    expect(reviewerSource).not.toContain('from "../git/annotate.js"')
    expect(reviewerSource).not.toContain("createAnnotatedFile")
    expect(reviewerSource).not.toContain("Annotated Files:")
  })
})
