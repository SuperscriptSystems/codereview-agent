import { z } from 'zod';

export const issueTypeValues = [
	'LogicError',
	'CodeStyle',
	'Security',
	'Suggestion',
	'TestCoverage',
	'Clarity',
	'Performance',
	'Other',
] as const;

export const issueTypeJsonSchemaValues = [...issueTypeValues];

export const issueTypeSchema = z.enum(issueTypeValues);
export type IssueType = z.infer<typeof issueTypeSchema>;

export const codeIssueSchema = z.preprocess(
	value => normalizeCodeIssue(value),
	z.object({
		filePath: z.string(),
		lineNumber: z.number().int().nonnegative(),
		issueType: issueTypeSchema,
		comment: z.string(),
		suggestion: z.string().optional(),
	}),
);
export type CodeIssue = z.infer<typeof codeIssueSchema>;

export const reviewResultSchema = z.object({
	issues: z.array(codeIssueSchema),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export const contextRequirementsSchema = z.object({
	requiredAdditionalFiles: z.array(z.string()),
	isSufficient: z.boolean(),
	reasoning: z.string(),
});
export type ContextRequirements = z.infer<typeof contextRequirementsSchema>;

export const mergeSummarySchema = z.object({
	relevanceScore: z.number().int().min(0).max(100),
	relevanceJustification: z.string(),
	dbTablesCreated: z.array(z.string()).default([]),
	dbTablesModified: z.array(z.string()).default([]),
	apiEndpointsAdded: z.array(z.string()).default([]),
	apiEndpointsModified: z.array(z.string()).default([]),
	commitSummary: z.string(),
});
export type MergeSummary = z.infer<typeof mergeSummarySchema>;

export const filteringConfigSchema = z.object({
	ignoredExtensions: z.array(z.string()).default([]),
	ignoredPaths: z.array(z.string()).default([]),
	ignoredPatterns: z.array(z.string()).default([]),
});
export type FilteringConfig = z.infer<typeof filteringConfigSchema>;

export const batchingConfigSchema = z.object({
	enabled: z.boolean().default(true),
	maxFilesPerBatch: z.number().int().positive().default(5),
	maxDiffCharsPerBatch: z.number().int().positive().default(40000),
});
export type BatchingConfig = z.infer<typeof batchingConfigSchema>;

export const reviewExclusionConfigSchema = z.object({
	excludeFromReview: z.boolean().default(true),
	logExcluded: z.boolean().default(true),
});
export type ReviewExclusionConfig = z.infer<typeof reviewExclusionConfigSchema>;

export const reviewConfigSchema = z.object({
	maxContextFiles: z.number().int().positive().default(25),
	focusAreas: z.array(issueTypeSchema).default(['LogicError']),
	customRules: z.array(z.string()).default([]),
	testKeywords: z.array(z.string()).default(['test', 'spec']),
	batching: batchingConfigSchema.default({
		enabled: true,
		maxFilesPerBatch: 5,
		maxDiffCharsPerBatch: 40000,
	}),
	filtering: filteringConfigSchema.default({
		ignoredExtensions: [],
		ignoredPaths: [],
		ignoredPatterns: [],
	}),
	lockfiles: reviewExclusionConfigSchema.default({
		excludeFromReview: true,
		logExcluded: true,
	}),
	noiseFiles: reviewExclusionConfigSchema.default({
		excludeFromReview: true,
		logExcluded: true,
	}),
	contextCleanup: z
		.object({
			enabled: z.boolean().default(false),
		})
		.default({ enabled: false }),
});
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;

export const opencodeConfigSchema = z.object({
	model: z.string().optional(),
	review: reviewConfigSchema.default({
		maxContextFiles: 25,
		focusAreas: ['LogicError'],
		customRules: [],
		testKeywords: ['test', 'spec'],
		batching: {
			enabled: true,
			maxFilesPerBatch: 5,
			maxDiffCharsPerBatch: 40000,
		},
		filtering: {
			ignoredExtensions: [],
			ignoredPaths: [],
			ignoredPatterns: [],
		},
		lockfiles: {
			excludeFromReview: true,
			logExcluded: true,
		},
		noiseFiles: {
			excludeFromReview: true,
			logExcluded: true,
		},
		contextCleanup: { enabled: false },
	}),
});
export type OpencodeReviewerConfig = z.infer<typeof opencodeConfigSchema>;

export type ChangedFileMap = Record<string, string>;
export type FileContentMap = Record<string, string>;

export const reviewIssuesEnvelopeSchema = z.object({
	issues: z.array(codeIssueSchema),
});

export const reviewIssuesEnvelopeJsonSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		issues: {
			type: 'array',
			description:
				'Concrete, high-confidence review findings in changed files only.',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					filePath: {
						type: 'string',
						description: 'Changed file path relative to the repository root.',
					},
					lineNumber: {
						type: 'integer',
						minimum: 0,
						description:
							'Line number in the new file version where the issue should be attached.',
					},
					issueType: {
						type: 'string',
						enum: issueTypeJsonSchemaValues,
						description: 'Classification of the issue.',
					},
					comment: {
						type: 'string',
						description:
							'Short explanation of the concrete issue and why it matters.',
					},
					suggestion: {
						type: 'string',
						description: 'Optional concrete fix suggestion.',
					},
				},
				required: ['filePath', 'lineNumber', 'issueType', 'comment'],
			},
		},
	},
	required: ['issues'],
} as const;

export const contextRequirementsJsonSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		requiredAdditionalFiles: {
			type: 'array',
			items: { type: 'string' },
			description:
				'Additional file paths needed to confidently review the current change set.',
		},
		isSufficient: {
			type: 'boolean',
			description:
				'Whether the currently provided context is sufficient for review.',
		},
		reasoning: {
			type: 'string',
			description:
				'Brief explanation of why more context is or is not required.',
		},
	},
	required: ['requiredAdditionalFiles', 'isSufficient', 'reasoning'],
} as const;

export const mergeSummaryJsonSchema = {
	type: 'object',
	additionalProperties: false,
	properties: {
		relevanceScore: {
			type: 'integer',
			minimum: 0,
			maximum: 100,
			description:
				'Score indicating how well the change aligns with the Jira task.',
		},
		relevanceJustification: {
			type: 'string',
			description: 'Short justification for the relevance score.',
		},
		dbTablesCreated: {
			type: 'array',
			items: { type: 'string' },
			description: 'Database tables created by the change.',
		},
		dbTablesModified: {
			type: 'array',
			items: { type: 'string' },
			description: 'Database tables modified by the change.',
		},
		apiEndpointsAdded: {
			type: 'array',
			items: { type: 'string' },
			description: 'API endpoints added by the change.',
		},
		apiEndpointsModified: {
			type: 'array',
			items: { type: 'string' },
			description: 'API endpoints modified by the change.',
		},
		commitSummary: {
			type: 'string',
			description: 'Short technical summary of the implemented change.',
		},
	},
	required: [
		'relevanceScore',
		'relevanceJustification',
		'dbTablesCreated',
		'dbTablesModified',
		'apiEndpointsAdded',
		'apiEndpointsModified',
		'commitSummary',
	],
} as const;

function normalizeCodeIssue(value: unknown): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return value;
	}

	const candidate = value as Record<string, unknown>;

	return {
		...candidate,
		filePath: candidate.filePath ?? candidate.file ?? candidate.path,
		lineNumber: candidate.lineNumber ?? candidate.line,
		issueType: candidate.issueType ?? candidate.type,
		comment: candidate.comment ?? candidate.description ?? candidate.message,
	};
}
