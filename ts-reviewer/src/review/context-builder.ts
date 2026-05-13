import type { ContextRequirements, FileContentMap } from "../core/models.js"
import { contextRequirementsSchema } from "../core/models.js"
import type { OpencodeSessionClient } from "../opencode/client.js"
import { buildStructuredOutputInstructions, parseStructuredOutput } from "../opencode/structured-output.js"

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
  const responseText = await client.promptText(sessionId, {
    agent: "context-builder",
    prompt,
  })

  return parseStructuredOutput(responseText, contextRequirementsSchema, {
    requiredAdditionalFiles: [],
    isSufficient: true,
    reasoning: "Failed to parse context builder response.",
  })
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
    buildStructuredOutputInstructions(
      "Return a single JSON object with keys requiredAdditionalFiles, isSufficient, and reasoning.",
      contextRequirementsSchema,
    ),
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
