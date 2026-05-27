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

      if (
        url.includes("/pulls/12/comments?") ||
        url.includes("/issues/12/comments?") ||
        url.includes("/pulls/12/reviews?")
      ) {
        return makeResponse(200, [])
      }

      if (url.endsWith("/user")) {
        return makeResponse(200, { login: "github-actions[bot]" })
      }

      if (url.endsWith("/pulls/12") && method === "GET") {
        return makeResponse(200, { head: { sha: "abc123" }, user: { login: "another-user" } })
      }

      if (url.endsWith("/issues/12/comments") && method === "POST") {
        return makeResponse(201, { id: 1 })
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await handlePrResults([], {})

    expect(calls.some((call) => call.url.endsWith("/issues/12/comments") && call.method === "POST")).toBe(true)
    expect(calls.some((call) => call.body?.includes("didn't find any issues"))).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/pulls/12/reviews") && call.body?.includes("APPROVE"))).toBe(true)
  })

  it("skips auto-approval when the authenticated reviewer is the PR author", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (
        url.includes("/pulls/12/comments?") ||
        url.includes("/issues/12/comments?") ||
        url.includes("/pulls/12/reviews?")
      ) {
        return makeResponse(200, [])
      }

      if (url.endsWith("/user")) {
        return makeResponse(200, { login: "github-actions[bot]" })
      }

      if (url.endsWith("/pulls/12") && method === "GET") {
        return makeResponse(200, { user: { login: "github-actions[bot]" } })
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await handlePrResults([], {})

    expect(calls.some((call) => call.url.endsWith("/pulls/12/reviews") && call.body?.includes("APPROVE"))).toBe(false)
  })

  it("does not fail the run when GitHub rejects auto-approval", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (
        url.includes("/pulls/12/comments?") ||
        url.includes("/issues/12/comments?") ||
        url.includes("/pulls/12/reviews?")
      ) {
        return makeResponse(200, [])
      }

      if (url.endsWith("/user")) {
        return makeResponse(200, { login: "github-actions[bot]" })
      }

      if (url.endsWith("/pulls/12") && method === "GET") {
        return makeResponse(200, { user: { login: "another-user" } })
      }

      if (url.endsWith("/pulls/12/reviews") && method === "POST") {
        return makeResponse(422, { message: "Validation Failed", errors: [{ message: "Cannot approve your own pull request" }] })
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await expect(handlePrResults([], {})).resolves.toBeUndefined()
    expect(calls.some((call) => call.url.endsWith("/issues/12/comments") && call.method === "POST")).toBe(true)
  })

  it("posts summary, inline comments, and approves when issues exist", async () => {
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

      if (url.includes("/pulls/12/comments?")) {
        return makeResponse(200, [])
      }

      if (url.includes("/issues/12/comments?")) {
        if (method === "GET") {
          return makeResponse(200, [])
        }

        return makeResponse(201, { id: 1 })
      }

      if (url.endsWith("/issues/12/comments")) {
        if (method === "GET") {
          return makeResponse(200, [])
        }

        return makeResponse(201, { id: 1 })
      }

      if (url.includes("/pulls/12/reviews?") && method === "GET") {
        return makeResponse(200, [])
      }

      if (url.endsWith("/pulls/12")) {
        return makeResponse(200, { head: { sha: "abc123" } })
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await handlePrResults([issue], { "src/main.ts": [issue] })

    expect(calls.some((call) => call.url.endsWith("/issues/12/comments") && call.body?.includes("AI Code Review Summary"))).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/pulls/12/reviews") && call.body?.includes("APPROVE"))).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/pulls/12/reviews") && call.body?.includes("src/main.ts"))).toBe(true)
  })

  it("cleans up bot comments and reviews across paginated GitHub results", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = []

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : undefined
      calls.push({ url, method, body })

      if (url.includes("/pulls/12/comments?per_page=100&page=1")) {
        return makeResponse(200, Array.from({ length: 100 }, (_, index) => ({ id: index + 1, user: { login: "github-actions[bot]" } })))
      }

      if (url.includes("/pulls/12/comments?per_page=100&page=2")) {
        return makeResponse(200, [{ id: 201, user: { login: "github-actions[bot]" } }])
      }

      if (url.includes("/issues/12/comments?per_page=100&page=1")) {
        return makeResponse(200, [{ id: 301, user: { login: "github-actions[bot]" } }])
      }

      if (url.includes("/pulls/12/reviews?per_page=100&page=1")) {
        return makeResponse(200, [{ id: 401, state: "CHANGES_REQUESTED", user: { login: "github-actions[bot]" } }])
      }

      return makeResponse(201, { id: 1 })
    }) as typeof fetch

    await handlePrResults([], {})

    expect(calls.some((call) => call.url.endsWith("/pulls/comments/201") && call.method === "DELETE")).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/issues/comments/301") && call.method === "DELETE")).toBe(true)
    expect(calls.some((call) => call.url.endsWith("/reviews/401/dismissals") && call.method === "PUT")).toBe(true)
  })
})
