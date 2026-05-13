import { z } from "zod"

const beginMarker = "BEGIN_JSON"
const endMarker = "END_JSON"

export function buildStructuredOutputInstructions(description: string, schema: z.ZodTypeAny): string {
  return [
    description,
    `Wrap your final JSON payload between ${beginMarker} and ${endMarker}.`,
    "Do not include any prose before or after the wrapped JSON.",
    "Return valid JSON only inside the markers.",
    "Expected JSON schema:",
    JSON.stringify(schemaToJson(schema), null, 2),
  ].join("\n")
}

export function parseStructuredOutput<T>(text: string, schema: z.ZodSchema<T>, fallback: T): T {
  const candidatePayloads = [
    extractTaggedPayload(text),
    extractFencedJson(text),
    extractJsonObject(text),
    extractJsonArray(text),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidatePayloads) {
    try {
      return schema.parse(JSON.parse(candidate) as unknown)
    } catch {
      continue
    }
  }

  return fallback
}

export function parseStructuredOutputOrNull<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T | null {
  const candidatePayloads = [
    extractTaggedPayload(text),
    extractFencedJson(text),
    extractJsonObject(text),
    extractJsonArray(text),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of candidatePayloads) {
    try {
      return schema.parse(JSON.parse(candidate) as unknown)
    } catch {
      continue
    }
  }

  return null
}

function extractTaggedPayload(text: string): string | null {
  const start = text.indexOf(beginMarker)
  const end = text.lastIndexOf(endMarker)

  if (start === -1 || end === -1 || end <= start) {
    return null
  }

  return text.slice(start + beginMarker.length, end).trim()
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

function schemaToJson(schema: z.ZodTypeAny): unknown {
  const schemaWithToJson = schema as unknown as { toJSON?: () => unknown }
  if (typeof schemaWithToJson.toJSON === "function") {
    return schemaWithToJson.toJSON()
  }

  return { type: "object" }
}

export const structuredOutputMarkers = {
  begin: beginMarker,
  end: endMarker,
}
