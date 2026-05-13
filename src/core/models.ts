import { z } from "zod"

export const issueTypeValues = [
  "LogicError",
  "CodeStyle",
  "Security",
  "Suggestion",
  "TestCoverage",
  "Clarity",
  "Performance",
  "Other",
] as const

export const issueTypeSchema = z.enum(issueTypeValues)
export type IssueType = z.infer<typeof issueTypeSchema>

export const codeIssueSchema = z.preprocess((value) => normalizeCodeIssue(value), z.object({
  filePath: z.string(),
  lineNumber: z.number().int().nonnegative(),
  issueType: issueTypeSchema,
  comment: z.string(),
  suggestion: z.string().optional(),
}))
export type CodeIssue = z.infer<typeof codeIssueSchema>

export const reviewResultSchema = z.object({
  issues: z.array(codeIssueSchema),
})
export type ReviewResult = z.infer<typeof reviewResultSchema>

export const contextRequirementsSchema = z.object({
  requiredAdditionalFiles: z.array(z.string()),
  isSufficient: z.boolean(),
  reasoning: z.string(),
})
export type ContextRequirements = z.infer<typeof contextRequirementsSchema>

export const mergeSummarySchema = z.object({
  relevanceScore: z.number().int().min(0).max(100),
  relevanceJustification: z.string(),
  dbTablesCreated: z.array(z.string()).default([]),
  dbTablesModified: z.array(z.string()).default([]),
  apiEndpointsAdded: z.array(z.string()).default([]),
  apiEndpointsModified: z.array(z.string()).default([]),
  commitSummary: z.string(),
})
export type MergeSummary = z.infer<typeof mergeSummarySchema>

export const filteringConfigSchema = z.object({
  ignoredExtensions: z.array(z.string()).default([]),
  ignoredPaths: z.array(z.string()).default([]),
  ignoredPatterns: z.array(z.string()).default([]),
})
export type FilteringConfig = z.infer<typeof filteringConfigSchema>

export const reviewConfigSchema = z.object({
  maxContextFiles: z.number().int().positive().default(25),
  focusAreas: z.array(issueTypeSchema).default(["LogicError"]),
  customRules: z.array(z.string()).default([]),
  testKeywords: z.array(z.string()).default(["test", "spec"]),
  filtering: filteringConfigSchema.default({
    ignoredExtensions: [],
    ignoredPaths: [],
    ignoredPatterns: [],
  }),
  contextCleanup: z.object({
    enabled: z.boolean().default(false),
  }).default({ enabled: false }),
})
export type ReviewConfig = z.infer<typeof reviewConfigSchema>

export const opencodeConfigSchema = z.object({
  model: z.string().optional(),
  review: reviewConfigSchema.default({
    maxContextFiles: 25,
    focusAreas: ["LogicError"],
    customRules: [],
    testKeywords: ["test", "spec"],
    filtering: {
      ignoredExtensions: [],
      ignoredPaths: [],
      ignoredPatterns: [],
    },
    contextCleanup: { enabled: false },
  }),
})
export type OpencodeReviewerConfig = z.infer<typeof opencodeConfigSchema>

export type ChangedFileMap = Record<string, string>
export type FileContentMap = Record<string, string>

export const reviewIssuesEnvelopeSchema = z.object({
  issues: z.array(codeIssueSchema),
})

function normalizeCodeIssue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value
  }

  const candidate = value as Record<string, unknown>

  return {
    ...candidate,
    filePath: candidate.filePath ?? candidate.file ?? candidate.path,
    lineNumber: candidate.lineNumber ?? candidate.line,
    issueType: candidate.issueType ?? candidate.type,
    comment: candidate.comment ?? candidate.description ?? candidate.message,
  }
}
