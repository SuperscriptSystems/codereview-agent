import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"

export interface OpencodeSessionClient {
  createSession(title: string): Promise<string>
  listAgents(): Promise<string[]>
  promptText(sessionId: string, options: { agent: string; system?: string; prompt: string }): Promise<string>
  promptStructured<T>(
    sessionId: string,
    options: { agent: string; system?: string; prompt: string; schema: Record<string, unknown>; retryCount?: number },
  ): Promise<T>
  close(): Promise<void>
}

export async function createSessionClient(config: Record<string, unknown>, directory?: string): Promise<OpencodeSessionClient> {
  const port = await getAvailablePort()
  const server = await startIsolatedOpencodeServer(sanitizeOpencodeServerConfig(config), port)
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory,
  })

  return {
    async createSession(title: string): Promise<string> {
      const response = await client.session.create({ title })
      const data = getResponseData<{ id?: string }>(response)

      if (!data?.id) {
        throw new Error(buildOpencodeErrorMessage("create a session", response, "OpenCode did not return a session payload."))
      }

      return data.id
    },
    async listAgents(): Promise<string[]> {
      const response = await client.app.agents()
      const data = getResponseData<Array<{ name?: string }>>(response)

      if (!Array.isArray(data)) {
        throw new Error(buildOpencodeErrorMessage(
          "list available agents",
          response,
          "OpenCode did not return an agent list payload.",
        ))
      }

      return data
        .flatMap((agent) => typeof agent?.name === "string" ? [agent.name] : [])
        .sort((left, right) => left.localeCompare(right))
    },
    async promptText(sessionId: string, options: { agent: string; system?: string; prompt: string }): Promise<string> {
      const response = await client.session.prompt({
        sessionID: sessionId,
        agent: options.agent,
        system: options.system,
        parts: [{ type: "text", text: options.prompt }],
      })
      const data = getResponseData<{ parts?: Array<{ type: string; text?: string }> }>(response)

      if (!data?.parts) {
        throw new Error(buildOpencodeErrorMessage("run a prompt", response, "OpenCode did not return a prompt response payload."))
      }

      return extractTextFromParts(data.parts)
    },
    async promptStructured<T>(
      sessionId: string,
      options: { agent: string; system?: string; prompt: string; schema: Record<string, unknown>; retryCount?: number },
    ): Promise<T> {
      const response = await client.session.prompt({
        sessionID: sessionId,
        agent: options.agent,
        system: options.system,
        parts: [{ type: "text", text: options.prompt }],
        format: {
          type: "json_schema",
          retryCount: options.retryCount ?? 3,
          schema: options.schema,
        },
      })

      const info = getStructuredOutputInfo(response)
      if (info?.error?.name === "StructuredOutputError") {
        throw new Error(info.error.message ?? "OpenCode structured output validation failed.")
      }

      const textFallback = extractStructuredPayloadFromText<T>(response)
      if (textFallback !== null) {
        return textFallback
      }

      if (info?.structured_output === undefined) {
        const secondaryTextFallback = await promptStructuredViaTextFallback<T>(client, sessionId, options)
        if (secondaryTextFallback !== null) {
          return secondaryTextFallback
        }

        const promptText = extractPromptText(response)
        const details = promptText ? ` Raw response text: ${truncateText(promptText, 400)}` : ""
        throw new Error(buildOpencodeErrorMessage(
          "run a structured prompt",
          response,
          `OpenCode did not return a structured output payload.${details}`,
        ))
      }

      return info.structured_output as T
    },
    async close(): Promise<void> {
      await server.close()
    },
  }
}

async function startIsolatedOpencodeServer(config: Record<string, unknown>, port: number): Promise<{ url: string; close(): Promise<void> }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "code-review-agent-opencode-"))
  const proc = spawn("opencode", ["serve", `--hostname=127.0.0.1`, `--port=${port}`], {
    cwd,
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_SERVER_USERNAME: "",
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
  })

  let settled = false
  let output = ""
  const url = await new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      proc.kill()
      reject(new Error(`Timeout waiting for OpenCode server startup on port ${port}`))
    }, 5000)

    proc.stdout?.on("data", (chunk) => {
      if (settled) {
        return
      }

      output += chunk.toString()
      const lines = output.split("\n")
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) {
          continue
        }

        const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
        if (!match) {
          settled = true
          clearTimeout(timeoutId)
          proc.kill()
          reject(new Error(`Failed to parse OpenCode server URL from output: ${line}`))
          return
        }

        settled = true
        clearTimeout(timeoutId)
        resolve(match[1])
        return
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
    })

    proc.on("error", (error) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutId)
      reject(error)
    })

    proc.on("exit", (code) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutId)
      const details = output.trim() ? `\nServer output: ${output}` : ""
      reject(new Error(`Server exited with code ${code}${details}`))
    })
  })

  return {
    url,
    async close(): Promise<void> {
      await shutdownChildProcess(proc)
      await rm(cwd, { recursive: true, force: true })
    },
  }
}

async function shutdownChildProcess(proc: ReturnType<typeof spawn>): Promise<void> {
  if (proc.exitCode !== null || proc.killed) {
    return
  }

  const exited = waitForProcessExit(proc)
  proc.kill("SIGTERM")

  const terminated = await Promise.race([
    exited.then(() => true),
    wait(3000).then(() => false),
  ])

  if (terminated) {
    return
  }

  proc.kill("SIGKILL")
  await Promise.race([
    exited,
    wait(2000),
  ])
}

function waitForProcessExit(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    proc.once("exit", () => resolve())
    proc.once("error", () => resolve())
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine an available OpenCode server port.")))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(port)
      })
    })
  })
}

function sanitizeOpencodeServerConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { review: _review, __configDir, ...serverConfig } = config as Record<string, unknown> & { __configDir?: string }
  return resolveFileReferences(serverConfig, typeof __configDir === "string" ? __configDir : process.cwd()) as Record<string, unknown>
}

function resolveFileReferences(value: unknown, configDir: string): unknown {
  if (typeof value === "string") {
    const match = value.match(/^\{file:(.+)\}$/)
    if (!match) {
      return value
    }

    const filePath = match[1]?.trim()
    if (!filePath) {
      return value
    }

    if (path.isAbsolute(filePath) || filePath.startsWith("~")) {
      return value
    }

    return `{file:${path.resolve(configDir, filePath)}}`
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveFileReferences(item, configDir))
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, resolveFileReferences(nestedValue, configDir)]),
    )
  }

  return value
}

function getResponseData<T>(response: unknown): T | undefined {
  if (!response || typeof response !== "object") {
    return undefined
  }

  const candidate = response as { data?: T; error?: unknown }
  if (candidate.error) {
    return undefined
  }

  if (candidate.data !== undefined) {
    return candidate.data
  }

  return response as T
}

function buildOpencodeErrorMessage(action: string, response: unknown, fallback: string): string {
  if (!response || typeof response !== "object") {
    return fallback
  }

  const candidate = response as {
    error?: unknown
    response?: { status?: number; statusText?: string }
  }

  if (!candidate.error) {
    return fallback
  }

  const errorText = typeof candidate.error === "string" ? candidate.error : JSON.stringify(candidate.error)
  const status = candidate.response?.status
  const statusText = candidate.response?.statusText
  const details = [status, statusText].filter(Boolean).join(" ")

  return details ? `OpenCode failed to ${action}: ${errorText} (${details})` : `OpenCode failed to ${action}: ${errorText}`
}

function getStructuredOutputInfo(response: unknown): { structured_output?: unknown; error?: { name?: string; message?: string } } | undefined {
  if (!response || typeof response !== "object") {
    return undefined
  }

  const candidate = response as {
    data?: {
      info?: {
        structured_output?: unknown
        structured?: unknown
        error?: { name?: string; message?: string; data?: { message?: string } }
      }
    }
    info?: {
      structured_output?: unknown
      structured?: unknown
      error?: { name?: string; message?: string; data?: { message?: string } }
    }
  }

  const info = candidate.data?.info ?? candidate.info
  if (!info) {
    return undefined
  }

  return {
    structured_output: info.structured_output ?? info.structured,
    error: info.error
      ? {
          name: info.error.name,
          message: info.error.message ?? info.error.data?.message,
        }
      : undefined,
  }
}

function extractStructuredPayloadFromText<T>(response: unknown): T | null {
  const text = extractPromptText(response)
  if (!text) {
    return null
  }

  const candidatePayloads = [
    extractTaggedPayload(text),
    extractFencedJson(text),
    extractJsonObject(text),
    extractJsonArray(text),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidatePayloads) {
    try {
      return JSON.parse(candidate) as T
    } catch {
      continue
    }
  }

  return null
}

function extractPromptText(response: unknown): string {
  if (!response || typeof response !== "object") {
    return ""
  }

  const data = getResponseData<{ parts?: Array<{ type: string; text?: string }> }>(response)
  if (!data?.parts) {
    return ""
  }

  return extractTextFromParts(data.parts)
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, maxLength - 3)}...`
}

function extractTaggedPayload(text: string): string | null {
  const start = text.indexOf("BEGIN_JSON")
  const end = text.lastIndexOf("END_JSON")

  if (start === -1 || end === -1 || end <= start) {
    return null
  }

  return text.slice(start + "BEGIN_JSON".length, end).trim()
}

function extractFencedJson(text: string): string | null {
  const fencedJsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i)
  if (fencedJsonMatch?.[1]) {
    return fencedJsonMatch[1].trim()
  }

  const fencedMatch = text.match(/```\s*([\s\S]*?)\s*```/i)
  return fencedMatch?.[1]?.trim() ?? null
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) {
    return null
  }

  return text.slice(start, end + 1)
}

function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) {
    return null
  }

  return text.slice(start, end + 1)
}

function extractTextFromParts(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

async function promptStructuredViaTextFallback<T>(
  client: OpencodeClient,
  sessionId: string,
  options: { agent: string; system?: string; prompt: string; schema: Record<string, unknown> },
): Promise<T | null> {
  const response = await client.session.prompt({
    sessionID: sessionId,
    agent: options.agent,
    system: options.system,
    parts: [{ type: "text", text: buildTextStructuredFallbackPrompt(options.prompt, options.schema) }],
  })

  return extractStructuredPayloadFromText<T>(response)
}

function buildTextStructuredFallbackPrompt(prompt: string, schema: Record<string, unknown>): string {
  return [
    prompt,
    "Return only valid JSON between BEGIN_JSON and END_JSON.",
    "Do not include any prose before or after the JSON.",
    "BEGIN_JSON",
    '{"issues":[]}',
    "END_JSON",
    "JSON schema:",
    JSON.stringify(schema, null, 2),
  ].join("\n\n")
}

export type { OpencodeClient }

export const __test__ = {
  getStructuredOutputInfo,
  extractStructuredPayloadFromText,
  extractPromptText,
  buildTextStructuredFallbackPrompt,
}
