import { beforeEach, describe, expect, it, vi } from "vitest"

const loadRawConfigMock = vi.fn()
const createSessionClientMock = vi.fn()

const loggerFns = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

vi.mock("../../src/config/load-config.js", () => ({
  loadRawConfig: loadRawConfigMock,
}))

vi.mock("../../src/opencode/client.js", () => ({
  createSessionClient: createSessionClientMock,
}))

vi.mock("../../src/core/logger.js", () => ({
  configureLogger: vi.fn(),
  logger: loggerFns,
}))

const { runCheckReviewerCommand } = await import("../../src/commands/check-reviewer.js")

describe("check-reviewer command", () => {
  const sessionClient = {
    createSession: vi.fn(),
    promptStructured: vi.fn(),
    close: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    loadRawConfigMock.mockResolvedValue({ agent: {} })
    createSessionClientMock.mockResolvedValue(sessionClient)
    sessionClient.createSession.mockResolvedValue("session-1")
    sessionClient.promptStructured.mockResolvedValue({ issues: [] })
  })

  it("verifies reviewer connectivity without a diff range", async () => {
    await runCheckReviewerCommand({ repoPath: "/repo", trace: true })

    expect(sessionClient.createSession).toHaveBeenCalledWith("reviewer-check")
    expect(sessionClient.promptStructured).toHaveBeenCalledWith("session-1", expect.objectContaining({
      agent: "reviewer",
    }))
    expect(loggerFns.info).toHaveBeenCalledWith("Reviewer connectivity check passed.")
    expect(sessionClient.close).toHaveBeenCalled()
  })
})
