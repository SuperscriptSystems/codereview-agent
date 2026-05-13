import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { closeMock } = vi.hoisted(() => ({
  closeMock: vi.fn(),
}))

vi.mock("../../src/config/load-config.ts", () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
  loadRawConfig: vi.fn().mockResolvedValue({ model: "openai/gpt-5" }),
}))

vi.mock("../../src/git/diff.ts", () => ({
  getCommitMessages: vi.fn().mockResolvedValue("feat: EX-123 add feature"),
  getStructuredDiffSummary: vi.fn().mockResolvedValue({ files_changed: [{ path: "src/main.ts", insertions: 10, deletions: 2 }] }),
}))

vi.mock("../../src/git/context.ts", () => ({
  getTaskIdFromGitInfo: vi.fn().mockResolvedValue("EX-123"),
}))

vi.mock("../../src/integrations/jira.ts", () => ({
  projectKeys: vi.fn().mockResolvedValue(new Set(["EX"])),
  getTaskDetails: vi.fn().mockResolvedValue({ summary: "Task", description: "Details" }),
  buildJiraDetailsText: vi.fn().mockReturnValue("jira context"),
  addAssessmentComment: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../src/opencode/client.ts", () => ({
  createSessionClient: vi.fn().mockResolvedValue({ close: closeMock }),
}))

vi.mock("../../src/review/summarizer.ts", () => ({
  summarizeChangesForJira: vi.fn().mockResolvedValue({
    relevanceScore: 90,
    relevanceJustification: "Matches task",
    dbTablesCreated: [],
    dbTablesModified: [],
    apiEndpointsAdded: [],
    apiEndpointsModified: [],
    commitSummary: "Summary",
  }),
}))

import { addAssessmentComment } from "../../src/integrations/jira.js"
import { createSessionClient } from "../../src/opencode/client.js"
import { summarizeChangesForJira } from "../../src/review/summarizer.js"
import { runAssessCommand } from "../../src/commands/assess.js"

describe("assess command", () => {
  beforeEach(() => {
    process.env.JIRA_URL = "https://example.atlassian.net"
    closeMock.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
    delete process.env.JIRA_URL
    delete process.env.JIRA_TASK_ID
  })

  it("summarizes changes and posts Jira assessment comment", async () => {
    await runAssessCommand({
      repoPath: ".",
      baseRef: "HEAD~1",
      headRef: "HEAD",
      trace: false,
    })

    expect(createSessionClient).toHaveBeenCalled()
    expect(summarizeChangesForJira).toHaveBeenCalled()
    expect(addAssessmentComment).toHaveBeenCalledWith(
      "EX-123",
      expect.objectContaining({ relevanceScore: 90, commitSummary: "Summary" }),
    )
    expect(closeMock).toHaveBeenCalled()
  })

  it("skips when Jira is not configured", async () => {
    delete process.env.JIRA_URL

    await runAssessCommand({
      repoPath: ".",
      baseRef: "HEAD~1",
      headRef: "HEAD",
      trace: false,
    })

    expect(createSessionClient).not.toHaveBeenCalled()
  })
})
