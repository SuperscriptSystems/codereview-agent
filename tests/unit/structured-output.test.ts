import { describe, expect, it } from "vitest"
import { z } from "zod"

import { reviewIssuesEnvelopeSchema } from "../../src/core/models.js"
import { buildStructuredOutputInstructions, parseStructuredOutput, structuredOutputMarkers } from "../../src/opencode/structured-output.js"

describe("structured output parser", () => {
  const schema = z.object({ value: z.string() })

  it("parses payload between markers", () => {
    const text = `ignored\n${structuredOutputMarkers.begin}\n{"value":"ok"}\n${structuredOutputMarkers.end}`
    expect(parseStructuredOutput(text, schema, { value: "fallback" })).toEqual({ value: "ok" })
  })

  it("parses fenced json payload", () => {
    const text = '```json\n{"value":"ok"}\n```'
    expect(parseStructuredOutput(text, schema, { value: "fallback" })).toEqual({ value: "ok" })
  })

  it("falls back when no valid payload exists", () => {
    expect(parseStructuredOutput("not json", schema, { value: "fallback" })).toEqual({ value: "fallback" })
  })

  it("includes marker instructions in generated prompt guidance", () => {
    const instructions = buildStructuredOutputInstructions("Return structured data.", schema)
    expect(instructions).toContain(structuredOutputMarkers.begin)
    expect(instructions).toContain(structuredOutputMarkers.end)
  })

  it("parses reviewer-style issue payloads", () => {
    const text = `Review complete.\n${structuredOutputMarkers.begin}\n{"issues":[{"filePath":"src/app.ts","lineNumber":12,"issueType":"LogicError","comment":"Broken null handling"}]}\n${structuredOutputMarkers.end}`
    expect(parseStructuredOutput(text, reviewIssuesEnvelopeSchema, { issues: [] })).toEqual({
      issues: [
        {
          filePath: "src/app.ts",
          lineNumber: 12,
          issueType: "LogicError",
          comment: "Broken null handling",
        },
      ],
    })
  })

  it("normalizes alternate reviewer issue field names", () => {
    const text = `Review complete.\n${structuredOutputMarkers.begin}\n{"issues":[{"file":"src/app.ts","line":12,"type":"LogicError","description":"Broken null handling"}]}\n${structuredOutputMarkers.end}`
    expect(parseStructuredOutput(text, reviewIssuesEnvelopeSchema, { issues: [] })).toEqual({
      issues: [
        {
          filePath: "src/app.ts",
          lineNumber: 12,
          issueType: "LogicError",
          comment: "Broken null handling",
        },
      ],
    })
  })

  it("normalizes reviewer issues that use message for the comment body", () => {
    const text = `Review complete.\n${structuredOutputMarkers.begin}\n{"issues":[{"file":"src/app.ts","line":12,"type":"LogicError","message":"Broken null handling"}]}\n${structuredOutputMarkers.end}`
    expect(parseStructuredOutput(text, reviewIssuesEnvelopeSchema, { issues: [] })).toEqual({
      issues: [
        {
          filePath: "src/app.ts",
          lineNumber: 12,
          issueType: "LogicError",
          comment: "Broken null handling",
        },
      ],
    })
  })
})
