import type { MergeSummary } from "../core/models.js"
import { logger } from "../core/logger.js"
import { findTaskId } from "../utils/task-id.js"

type JiraTaskDetails = {
  summary: string
  description: string
}

export function projectKeys(): Promise<Set<string>> {
  return fetchProjectKeys()
}

export async function getTaskDetails(taskId: string): Promise<JiraTaskDetails | null> {
  logger.info(`Fetching Jira task details for ${taskId}.`)

  try {
    const jiraUrl = getJiraUrl()
    const headers = getHeaders()

    for (const apiVersion of ["2", "3"]) {
      const response = await jiraFetch(`${jiraUrl}/rest/api/${apiVersion}/issue/${taskId.toUpperCase()}`, {
        headers,
      })

      if (response.status === 404) {
        continue
      }

      if (!response.ok) {
        logger.warn(`Jira lookup failed for ${taskId} with status ${response.status}.`)
        continue
      }

      const data = (await response.json()) as { fields?: { summary?: string; description?: unknown } }
      return {
        summary: data.fields?.summary ?? "N/A",
        description: extractDescription(data.fields?.description),
      }
    }

    return null
  } catch (error) {
    logger.warn(`Failed to fetch Jira task details: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export async function addAssessmentComment(taskId: string, summary: MergeSummary): Promise<void> {
  const adfBody = {
    version: 1,
    type: "doc",
    content: buildAssessmentNodes(summary),
  }

  await addComment(taskId, adfBody)
}

export async function addComment(taskId: string, comment: string | Record<string, unknown>): Promise<void> {
  logger.info(`Adding Jira comment for ${taskId}.`)

  try {
    const jiraUrl = getJiraUrl()
    const headers = getHeaders({ contentType: "application/json" })
    const primaryMarkerRaw = process.env.JIRA_AI_COMMENT_TAG ?? "*🤖 AI Assessment Complete*"
    const primaryMarkerClean = primaryMarkerRaw.replaceAll("*", "")
    const legacyMarkers = ["🤖 AI Assessment Complete", "🤖 AI Assessment"]
    const allMarkers = [primaryMarkerRaw, ...legacyMarkers.filter((marker) => marker !== primaryMarkerRaw)]

    let targetVersion = "2"
    let body: string | Record<string, unknown> = comment

    if (typeof comment === "string") {
      const firstLine = comment.trim().split(/\r?\n/, 1)[0] ?? ""
      if (!allMarkers.some((marker) => firstLine.replaceAll("*", "").startsWith(marker.replaceAll("*", "")))) {
        body = `${primaryMarkerRaw}\n\n${comment}`
      }
    } else {
      targetVersion = "3"
      ensureAdfMarker(comment, primaryMarkerClean)
    }

    const accountId = await getCurrentAccountId()
    const expectedSignature = normalizeCommentSignature(body)
    const existingComments = await fetchComments(jiraUrl, taskId)

    if (hasMatchingAiComment(existingComments, allMarkers, accountId, expectedSignature)) {
      logger.info(`Skipping Jira comment for ${taskId} because the same AI assessment already exists.`)
      await removeDuplicateComments(jiraUrl, taskId, existingComments, allMarkers, accountId, expectedSignature)
      return
    }

    await removePreviousAiComments(jiraUrl, taskId, existingComments, allMarkers, accountId)

    const response = await jiraFetch(`${jiraUrl}/rest/api/${targetVersion}/issue/${taskId}/comment`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    })

    if (!response.ok) {
      logger.warn(`Failed to add Jira comment. Status ${response.status}.`)
      return
    }

    const commentsAfterPost = await fetchComments(jiraUrl, taskId)
    await removeDuplicateComments(jiraUrl, taskId, commentsAfterPost, allMarkers, accountId, expectedSignature)
  } catch (error) {
    logger.warn(`Failed to add Jira comment: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function buildJiraDetailsText(taskId: string, details: JiraTaskDetails): string {
  return [
    `--- JIRA TASK CONTEXT (${taskId}) ---`,
    `Title: ${details.summary}`,
    "Description:",
    details.description,
    "---------------------------------",
  ].join("\n")
}

async function fetchProjectKeys(): Promise<Set<string>> {
  try {
    const jiraUrl = getJiraUrl()
    const response = await jiraFetch(`${jiraUrl}/rest/api/3/project/search`, {
      headers: getHeaders(),
    })

    if (!response.ok) {
      return new Set<string>()
    }

    const data = (await response.json()) as { values?: Array<{ key?: string }> }
    return new Set((data.values ?? []).map((project) => project.key).filter((key): key is string => Boolean(key)))
  } catch {
    return new Set<string>()
  }
}

function getJiraUrl(): string {
  const jiraUrl = process.env.JIRA_URL?.replace(/\/$/, "")
  if (!jiraUrl) {
    throw new Error("JIRA_URL is not set.")
  }

  return jiraUrl
}

function getHeaders(options?: { contentType?: string }): HeadersInit {
  const email = process.env.JIRA_USER_EMAIL
  const token = process.env.JIRA_API_TOKEN
  if (!email || !token) {
    throw new Error("Jira credentials are not configured.")
  }

  const auth = Buffer.from(`${email}:${token}`).toString("base64")
  return {
    Accept: "application/json",
    Authorization: `Basic ${auth}`,
    ...(options?.contentType ? { "Content-Type": options.contentType } : {}),
  }
}

function extractDescription(description: unknown): string {
  if (!description) {
    return "No description found."
  }

  if (typeof description === "string") {
    return description
  }

  if (typeof description === "object" && description !== null && "content" in description) {
    const content = (description as { content?: Array<{ content?: Array<{ type?: string; text?: string }> }> }).content ?? []
    const textParts: string[] = []
    for (const block of content) {
      for (const part of block.content ?? []) {
        if (part.type === "text" && part.text) {
          textParts.push(part.text)
        }
      }
    }

    return textParts.length > 0 ? textParts.join("\n") : "No description found."
  }

  return String(description)
}

async function getCurrentAccountId(): Promise<string | null> {
  try {
    const response = await jiraFetch(`${getJiraUrl()}/rest/api/3/myself`, {
      headers: getHeaders(),
    })

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as { accountId?: string }
    return data.accountId ?? null
  } catch {
    return null
  }
}

async function removePreviousAiComments(
  jiraUrl: string,
  taskId: string,
  comments: JiraComment[],
  markers: string[],
  accountId: string | null,
): Promise<void> {
  try {
    for (const comment of comments) {
      if (!isManagedAiComment(comment, markers, accountId) || !comment.id) {
        continue
      }

      await deleteComment(jiraUrl, taskId, comment.id)
    }
  } catch {
    logger.debug("Skipping Jira AI comment cleanup because comment listing failed.")
  }
}

type JiraComment = {
  id?: string
  author?: { accountId?: string }
  body?: unknown
}

async function fetchComments(jiraUrl: string, taskId: string): Promise<JiraComment[]> {
  try {
    const response = await jiraFetch(`${jiraUrl}/rest/api/3/issue/${taskId}/comment?maxResults=100`, {
      headers: getHeaders(),
    })

    if (!response.ok) {
      return []
    }

    const data = (await response.json()) as { comments?: JiraComment[] }
    return data.comments ?? []
  } catch {
    return []
  }
}

async function removeDuplicateComments(
  jiraUrl: string,
  taskId: string,
  comments: JiraComment[],
  markers: string[],
  accountId: string | null,
  expectedSignature: string,
): Promise<void> {
  const duplicates = comments.filter((comment) => {
    return isManagedAiComment(comment, markers, accountId)
      && normalizeCommentSignature(comment.body) === expectedSignature
      && Boolean(comment.id)
  })

  for (const comment of duplicates.slice(1)) {
    await deleteComment(jiraUrl, taskId, comment.id as string)
  }
}

function hasMatchingAiComment(
  comments: JiraComment[],
  markers: string[],
  accountId: string | null,
  expectedSignature: string,
): boolean {
  return comments.some((comment) => {
    return isManagedAiComment(comment, markers, accountId) && normalizeCommentSignature(comment.body) === expectedSignature
  })
}

function isManagedAiComment(comment: JiraComment, markers: string[], accountId: string | null): boolean {
  const bodyText = extractBodyText(comment.body)
  const bodyNormalized = normalizeMarker(bodyText)
  const matchesMarker = markers.map(normalizeMarker).some((marker) => bodyNormalized.includes(marker))
  const sameAuthor = !accountId || comment.author?.accountId === accountId
  return matchesMarker && sameAuthor
}

async function deleteComment(jiraUrl: string, taskId: string, commentId: string): Promise<void> {
  await jiraFetch(`${jiraUrl}/rest/api/3/issue/${taskId}/comment/${commentId}`, {
    method: "DELETE",
    headers: getHeaders(),
  })
}

function extractBodyText(body: unknown): string {
  if (typeof body === "string") {
    return body
  }

  if (typeof body === "object" && body !== null && "content" in body) {
    return extractDescription(body)
  }

  return ""
}

function normalizeMarker(text: string): string {
  return text.replaceAll("*", "").trim()
}

function normalizeCommentSignature(body: unknown): string {
  const raw = typeof body === "string" ? body : extractBodyText(body)
  return normalizeMarker(raw).replace(/\s+/g, " ").trim()
}

function jiraFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(getJiraFetchTimeoutMs()),
  })
}

function getJiraFetchTimeoutMs(): number {
  const parsed = Number(process.env.JIRA_FETCH_TIMEOUT_MS)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15000
  }

  return parsed
}

function ensureAdfMarker(comment: Record<string, unknown>, markerText: string): void {
  const content = Array.isArray(comment.content) ? [...comment.content] : []
  const firstNode = content[0] as { content?: Array<{ text?: string }> } | undefined
  const firstText = firstNode?.content?.[0]?.text?.trim() ?? ""

  if (firstText.startsWith(markerText)) {
    comment.content = content
    return
  }

  content.unshift({
    type: "paragraph",
    content: [
      {
        type: "text",
        text: markerText,
        marks: [{ type: "strong" }],
      },
    ],
  })
  comment.content = content
}

function buildAssessmentNodes(summary: MergeSummary): Array<Record<string, unknown>> {
  const nodes: Array<Record<string, unknown>> = [
    {
      type: "paragraph",
      content: [{ type: "text", text: summary.commitSummary, marks: [{ type: "strong" }] }],
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: `Task Relevance Score: ${summary.relevanceScore}%` }],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: summary.relevanceJustification, marks: [{ type: "em" }] }],
    },
  ]

  if (summary.dbTablesCreated.length > 0 || summary.dbTablesModified.length > 0) {
    nodes.push({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Database Changes:" }],
    })
    nodes.push({
      type: "bulletList",
      content: [
        ...summary.dbTablesCreated.map((table) => createListItem("Created Table: ", table, "OK")),
        ...summary.dbTablesModified.map((table) => createListItem("Modified Table: ", table, "INFO")),
      ],
    })
  }

  if (summary.apiEndpointsAdded.length > 0 || summary.apiEndpointsModified.length > 0) {
    nodes.push({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "API Endpoint Changes:" }],
    })
    nodes.push({
      type: "bulletList",
      content: [
        ...summary.apiEndpointsAdded.map((endpoint) => createListItem("Added: ", endpoint, "OK")),
        ...summary.apiEndpointsModified.map((endpoint) => createListItem("Modified: ", endpoint, "INFO")),
      ],
    })
  }

  return nodes
}

function createListItem(prefixText: string, itemText: string, statusLabel: string): Record<string, unknown> {
  return {
    type: "listItem",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: `${statusLabel} ${prefixText}`, marks: [{ type: "strong" }] },
          { type: "text", text: itemText, marks: [{ type: "code" }] },
        ],
      },
    ],
  }
}

export { findTaskId }
