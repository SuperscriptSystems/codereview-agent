import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CodeIssue } from "../../src/core/models.js"
import { cleanupAndPostAllComments } from "../../src/integrations/bitbucket.js"

function makeResponse(status: number, jsonData?: unknown, text?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text ?? (jsonData ? JSON.stringify(jsonData) : ""),
    json: async () => jsonData,
  } as Response
}

describe("bitbucket integration", () => {
  const originalFetch = global.fetch
  const originalConsoleLog = console.log
  const originalConsoleWarn = console.warn
  let consoleLogSpy: ReturnType<typeof vi.fn>
  let consoleWarnSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.BITBUCKET_APP_USERNAME = "user"
    process.env.BITBUCKET_APP_PASSWORD = "pass"
    process.env.BITBUCKET_WORKSPACE = "workspace"
    process.env.BITBUCKET_REPO_SLUG = "repo"
    process.env.BITBUCKET_PR_ID = "7"
    consoleLogSpy = vi.fn()
    consoleWarnSpy = vi.fn()
    console.log = consoleLogSpy
    console.warn = consoleWarnSpy
  })

  afterEach(() => {
    global.fetch = originalFetch
    console.log = originalConsoleLog
    console.warn = originalConsoleWarn
    vi.restoreAllMocks()
  })

  it("approves pull request when there are no issues", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1" })
      }

      if (url.includes("/comments") && method === "GET") {
        return makeResponse(200, { values: [] })
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await cleanupAndPostAllComments([], {})

    expect(calls.some((call) => call.url.endsWith("/approve") && call.method === "POST")).toBe(true)
    expect(calls.some((call) => call.url.includes("/comments") && call.body?.includes("didn't find any issues"))).toBe(true)
  })

  it("posts inline comments and summary when issues exist", async () => {
    const issue: CodeIssue = {
      filePath: "src/main.ts",
      lineNumber: 12,
      issueType: "Security",
      comment: "Unsafe behavior",
    }
    const calls: Array<{ url: string; method: string; body?: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1" })
      }

      if (url.includes("/comments") && method === "GET") {
        return makeResponse(200, { values: [] })
      }

      if (url.endsWith("/approve") && method === "DELETE") {
        return makeResponse(204)
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await cleanupAndPostAllComments([issue], { "src/main.ts": [issue] })

    expect(calls.some((call) => call.url.endsWith("/approve") && call.method === "DELETE")).toBe(true)
    expect(calls.some((call) => call.url.includes("/comments") && call.body?.includes("Unsafe behavior"))).toBe(true)
    expect(calls.some((call) => call.url.includes("/comments") && call.body?.includes("AI Code Review Summary"))).toBe(true)
  })

  it("does not fail when removing a missing approval returns 400", async () => {
    const issue: CodeIssue = {
      filePath: "src/main.ts",
      lineNumber: 12,
      issueType: "Security",
      comment: "Unsafe behavior",
    }

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1" })
      }

      if (url.includes("/comments") && method === "GET") {
        return makeResponse(200, { values: [] })
      }

      if (url.endsWith("/approve") && method === "DELETE") {
        return makeResponse(400, undefined, "No approval to remove")
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await expect(cleanupAndPostAllComments([issue], { "src/main.ts": [issue] })).resolves.toBeUndefined()
  })

  it("does not fail when approving a pull request returns 400", async () => {
    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1" })
      }

      if (url.includes("/comments") && method === "GET") {
        return makeResponse(200, { values: [] })
      }

      if (url.endsWith("/approve") && method === "POST") {
        return makeResponse(400, undefined, "Approval not allowed")
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await expect(cleanupAndPostAllComments([], {})).resolves.toBeUndefined()
    expect(consoleWarnSpy).toHaveBeenCalledWith("[warn] Bitbucket could not approve for this pull request: Approval not allowed")
  })

  it("does not fail when approving a pull request returns 403", async () => {
    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1", display_name: "Reviewer Bot" })
      }

      if (url.endsWith("/pullrequests/7") && method === "GET") {
        return makeResponse(200, { author: { account_id: "acct-2" } })
      }

      if (url.includes("/comments") && method === "GET") {
        return makeResponse(200, { values: [] })
      }

      if (url.endsWith("/approve") && method === "POST") {
        return makeResponse(403, undefined, "Forbidden")
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await expect(cleanupAndPostAllComments([], {})).resolves.toBeUndefined()
    expect(consoleWarnSpy).toHaveBeenCalledWith("[warn] Bitbucket could not approve for this pull request: Forbidden")
  })

  it("skips auto-approval when the authenticated reviewer is the PR author", async () => {
    const calls: Array<{ url: string; method: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      calls.push({ url, method })

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1", display_name: "Reviewer Bot" })
      }

      if (url.endsWith("/pullrequests/7") && method === "GET") {
        return makeResponse(200, { author: { account_id: "acct-1", display_name: "Reviewer Bot" } })
      }

      if (url.includes("/comments") && method === "GET") {
        return makeResponse(200, { values: [] })
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await expect(cleanupAndPostAllComments([], {})).resolves.toBeUndefined()
    expect(calls.some((call) => call.url.endsWith("/approve") && call.method === "POST")).toBe(false)
    expect(consoleWarnSpy).toHaveBeenCalledWith("[warn] Skipping Bitbucket auto-approval because the authenticated reviewer Reviewer Bot is the PR author.")
  })

  it("does not fail when approval endpoints return plain-text error bodies", async () => {
    const issue: CodeIssue = {
      filePath: "src/main.ts",
      lineNumber: 12,
      issueType: "Security",
      comment: "Unsafe behavior",
    }

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1" })
      }

      if (url.includes("/comments") && method === "GET") {
        return makeResponse(200, { values: [] })
      }

      if (url.endsWith("/approve")) {
        return makeResponse(400, undefined, "Bad Request")
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await expect(cleanupAndPostAllComments([issue], { "src/main.ts": [issue] })).resolves.toBeUndefined()
    await expect(cleanupAndPostAllComments([], {})).resolves.toBeUndefined()
  })

  it("logs approval success when no issues are found and approval succeeds", async () => {
    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1" })
      }

      if (url.includes("/comments") && method === "GET") {
        return makeResponse(200, { values: [] })
      }

      if (url.endsWith("/approve") && method === "POST") {
        return makeResponse(200, { approved: true })
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await cleanupAndPostAllComments([], {})

    expect(consoleLogSpy).toHaveBeenCalledWith("Bitbucket pull request approved.")
  })

  it("cleans up bot comments across paginated comment results", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (url.endsWith("/user")) {
        return makeResponse(200, { account_id: "acct-1" })
      }

      if (url.endsWith("/pullrequests/7/comments") && method === "GET") {
        return makeResponse(200, {
          values: [{ id: 101, user: { account_id: "acct-1" } }],
          next: "https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests/7/comments?page=2",
        })
      }

      if (url.endsWith("/comments?page=2") && method === "GET") {
        return makeResponse(200, {
          values: [{ id: 202, user: { account_id: "acct-1" } }],
        })
      }

      return makeResponse(204)
    }) as typeof fetch

    await cleanupAndPostAllComments([], {})

    expect(calls.some((call) => call.url.endsWith("/comments/101") && call.method === "DELETE")).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/comments/202") && call.method === "DELETE")).toBe(true)
  })
})
