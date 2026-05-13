import type { ContextRequirements, FileContentMap } from "../core/models.js"
import { contextRequirementsJsonSchema, contextRequirementsSchema } from "../core/models.js"
import type { OpencodeSessionClient } from "../opencode/client.js"

export interface DetermineContextInput {
  diff: string
  commitMessages: string
  changedFilesContent: FileContentMap
  jiraDetails: string
  fullContextContent: FileContentMap
  fileStructure: string
  currentContextFiles: string[]
}

export async function determineContext(
  client: OpencodeSessionClient,
  input: DetermineContextInput,
): Promise<ContextRequirements> {
  const sessionId = await client.createSession("context-builder")
  const prompt = buildContextPrompt(input)
  return contextRequirementsSchema.parse(await client.promptStructured(sessionId, {
    agent: "context-builder",
    prompt,
    schema: contextRequirementsJsonSchema,
  }))
}

export async function determineContextBatch(
  client: OpencodeSessionClient,
  items: DetermineContextInput[],
): Promise<ContextRequirements[]> {
  return Promise.all(items.map((item) => determineContext(client, item)))
}

function buildContextPrompt(input: DetermineContextInput): string {
  const changedFilesSummary = Object.keys(input.changedFilesContent)
    .map((filePath) => `- ${filePath}`)
    .join("\n")

  const fullContextText = Object.entries(input.fullContextContent)
    .map(([filePath, content]) => `--- START FILE: ${filePath} ---\n${content}\n--- END FILE: ${filePath} ---`)
    .join("\n")

  return [
    "Return a JSON object matching the provided schema.",
    input.jiraDetails,
    "Commit Messages:",
    input.commitMessages,
    "Changed Files:",
    changedFilesSummary,
    "Current Context:",
    fullContextText,
    "Git Diff:",
    input.diff,
    "Files Already in Context:",
    input.currentContextFiles.join("\n"),
    "File Structure:",
    input.fileStructure,
  ].join("\n\n")
}
