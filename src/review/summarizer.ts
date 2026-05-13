import { mergeSummaryJsonSchema, mergeSummarySchema, type MergeSummary } from "../core/models.js"
import type { OpencodeSessionClient } from "../opencode/client.js"

export async function summarizeChangesForJira(
  client: OpencodeSessionClient,
  input: {
    jiraDetails: string
    commitMessages: string
    diffSummary: Record<string, unknown>
  },
): Promise<MergeSummary | null> {
  const sessionId = await client.createSession("summarizer")
  const prompt = [
    "Jira Task Details:",
    input.jiraDetails,
    "Commit Messages:",
    input.commitMessages,
    "Structured Summary of Code Changes:",
    JSON.stringify(input.diffSummary, null, 2),
  ].join("\n\n")

  const parsed = mergeSummarySchema.parse(await client.promptStructured(sessionId, {
    agent: "summarizer",
    prompt,
    schema: mergeSummaryJsonSchema,
  }))

  return {
    ...parsed,
    dbTablesCreated: Array.isArray(parsed.dbTablesCreated) ? parsed.dbTablesCreated : [],
    dbTablesModified: Array.isArray(parsed.dbTablesModified) ? parsed.dbTablesModified : [],
    apiEndpointsAdded: Array.isArray(parsed.apiEndpointsAdded) ? parsed.apiEndpointsAdded : [],
    apiEndpointsModified: Array.isArray(parsed.apiEndpointsModified) ? parsed.apiEndpointsModified : [],
  }
}
