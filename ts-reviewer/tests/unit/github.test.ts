import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CodeIssue } from "../../src/core/models.js"
import { handlePrResults } from "../../src/integrations/github.js"

function makeResponse(status: number, jsonData?: unknown, text?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text ?? (jsonData ? JSON.stringify(jsonData) : ""),
    json: async () => jsonData,
  } as Response
}

describe("github integration", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "token"
    process.env.GITHUB_REPOSITORY = "owner/repo"
    process.env.GITHUB_PR_NUMBER = "12"
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("posts approval comment when there are no issues", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (url.endsWith("/pulls/12/comments") || url.endsWith("/issues/12/comments") || url.endsWith("/pulls/12/reviews")) {
        return makeResponse(200, [])
      }

      if (url.endsWith("/issues/12/comments") && method === "POST") {
        return makeResponse(201, { id: 1 })
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await handlePrResults([], {})

    expect(calls.some((call) => call.url.endsWith("/issues/12/comments") && call.method === "POST")).toBe(true)
    expect(calls.some((call) => call.body?.includes("didn't find any issues"))).toBe(true)
  })

  it("posts summary, inline comments, and requests changes when issues exist", async () => {
    const issue: CodeIssue = {
      filePath: "src/main.ts",
      lineNumber: 10,
      issueType: "LogicError",
      comment: "Bug found",
      suggestion: "return true",
    }
    const calls: Array<{ url: string; method: string; body?: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (url.endsWith("/pulls/12/comments")) {
        return makeResponse(200, [])
      }

      if (url.endsWith("/issues/12/comments")) {
        if (method === "GET") {
          return makeResponse(200, [])
        }

        return makeResponse(201, { id: 1 })
      }

      if (url.endsWith("/pulls/12/reviews") && method === "GET") {
        return makeResponse(200, [])
      }

      if (url.endsWith("/pulls/12/commits")) {
        return makeResponse(200, [{ sha: "abc123" }])
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await handlePrResults([issue], { "src/main.ts": [issue] })

    expect(calls.some((call) => call.url.endsWith("/issues/12/comments") && call.body?.includes("AI Code Review Summary"))).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/pulls/12/reviews") && call.body?.includes("REQUEST_CHANGES"))).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/pulls/12/reviews") && call.body?.includes("src/main.ts"))).toBe(true)
  })
})
