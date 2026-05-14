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
    listAgents: vi.fn(),
    createSession: vi.fn(),
    promptStructured: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    loadRawConfigMock.mockResolvedValue({ agent: {} })
    createSessionClientMock.mockResolvedValue(sessionClient)
    sessionClient.listAgents.mockResolvedValue(["reviewer", "general"])
    sessionClient.createSession.mockResolvedValue("session-1")
    sessionClient.promptStructured.mockResolvedValue({ issues: [] })
  })

  it("verifies reviewer connectivity without a diff range", async () => {
    await runCheckReviewerCommand({ repoPath: "/repo", trace: true })

    expect(sessionClient.listAgents).toHaveBeenCalled()
    expect(sessionClient.createSession).toHaveBeenCalledWith("reviewer-check")
    expect(sessionClient.promptStructured).toHaveBeenCalledWith("session-1", expect.objectContaining({
      agent: "reviewer",
    }))
    expect(loggerFns.info).toHaveBeenCalledWith("Reviewer connectivity check passed.")
    expect(sessionClient.close).toHaveBeenCalled()
  })

  it("falls back to the general agent when reviewer is unavailable", async () => {
    sessionClient.listAgents.mockResolvedValue(["general", "plan"])

    await runCheckReviewerCommand({ repoPath: "/repo", trace: true })

    expect(sessionClient.promptStructured).toHaveBeenCalledWith("session-1", expect.objectContaining({
      agent: "general",
      system: expect.stringContaining("You are a ready-to-use code reviewer."),
    }))
    expect(loggerFns.error).toHaveBeenCalledWith(
      "Custom reviewer agent is unavailable. Fallback via 'general' succeeded, but reviewer registration is missing. Available agents: general, plan",
    )
    expect(loggerFns.info).not.toHaveBeenCalledWith("Reviewer connectivity check passed.")
  })

  it("uses a direct reviewer attempt first when agent discovery is unavailable", async () => {
    sessionClient.listAgents.mockRejectedValue(new Error("endpoint unavailable"))
    sessionClient.promptStructured
      .mockRejectedValueOnce(new Error('OpenCode failed to run a structured prompt: {"name":"UnknownError","data":{"message":"Agent not found: \"reviewer\"."}} (500 Internal Server Error)'))
      .mockResolvedValueOnce({ issues: [] })

    await runCheckReviewerCommand({ repoPath: "/repo", trace: true })

    expect(sessionClient.promptStructured).toHaveBeenNthCalledWith(1, "session-1", expect.objectContaining({ agent: "reviewer" }))
    expect(sessionClient.promptStructured).toHaveBeenNthCalledWith(2, "session-1", expect.objectContaining({
      agent: "general",
      system: expect.stringContaining("You are a ready-to-use code reviewer."),
    }))
    expect(loggerFns.error).toHaveBeenCalledWith(
      "Custom reviewer agent is unavailable. Fallback via 'general' succeeded, but reviewer registration is missing.",
    )
  })
})
