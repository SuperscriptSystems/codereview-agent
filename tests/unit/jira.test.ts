import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { addComment } from "../../src/integrations/jira.js"

const taskId = "EX-999"

function makeResponse(status: number, jsonData?: unknown, text?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text ?? (jsonData ? JSON.stringify(jsonData) : ""),
    json: async () => jsonData,
  } as Response
}

describe("jira comments", () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env.JIRA_URL = "https://example.atlassian.net"
    process.env.JIRA_USER_EMAIL = "bot@example.com"
    process.env.JIRA_API_TOKEN = "tok"
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it("replaces previous AI comments and posts a new one", async () => {
    const calls: { get: string[]; delete: string[]; post: Array<{ url: string; body: string }> } = {
      get: [],
      delete: [],
      post: [],
    }

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (method === "GET") {
        calls.get.push(url)
        if (url.endsWith("/myself")) {
          return makeResponse(200, { accountId: "acct-1" })
        }
        if (url.includes(`/issue/${taskId}/comment`)) {
          return makeResponse(200, {
            comments: [
              { id: "10", author: { accountId: "acct-1" }, body: "🤖 AI Assessment\nOld body" },
              { id: "11", author: { accountId: "acct-1" }, body: "*🤖 AI Assessment Complete*\nPrevious" },
            ],
          })
        }
      }

      if (method === "DELETE") {
        calls.delete.push(url)
        return makeResponse(204)
      }

      if (method === "POST") {
        calls.post.push({ url, body: String(init?.body ?? "") })
        return makeResponse(201, { id: "900" })
      }

      return makeResponse(404)
    }) as typeof fetch

    await addComment(taskId, "Relevance: *85%*\n\nJustification: test")

    expect(calls.get.some((url) => url.endsWith("/myself"))).toBe(true)
    expect(calls.delete).toHaveLength(2)
    expect(calls.post).toHaveLength(1)
    expect(calls.post[0]?.body).toContain("*🤖 AI Assessment Complete*")
  })

  it("skips posting when the same AI assessment already exists", async () => {
    const calls: { get: string[]; delete: string[]; post: Array<{ url: string; body: string }> } = {
      get: [],
      delete: [],
      post: [],
    }

    global.fetch = vi.fn(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? "GET"

      if (method === "GET") {
        calls.get.push(url)
        if (url.endsWith("/myself")) {
          return makeResponse(200, { accountId: "acct-1" })
        }
        if (url.includes(`/issue/${taskId}/comment`)) {
          return makeResponse(200, {
            comments: [
              { id: "11", author: { accountId: "acct-1" }, body: "*🤖 AI Assessment Complete*\n\nRelevance: *85%*\n\nJustification: test" },
            ],
          })
        }
      }

      if (method === "DELETE") {
        calls.delete.push(url)
        return makeResponse(204)
      }

      if (method === "POST") {
        calls.post.push({ url, body: String(init?.body ?? "") })
        return makeResponse(201, { id: "900" })
      }

      return makeResponse(404)
    }) as typeof fetch

    await addComment(taskId, "Relevance: *85%*\n\nJustification: test")

    expect(calls.post).toHaveLength(0)
    expect(calls.delete).toHaveLength(0)
  })
})
