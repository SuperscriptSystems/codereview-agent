import { describe, expect, it } from 'vitest';

import {
	buildReviewBatches,
	buildReviewPrompt,
	runReview,
	type RunReviewInput,
} from '../../src/review/reviewer.js';

describe('reviewer', () => {
	const input: RunReviewInput = {
		repoPath: '/repo',
		staged: false,
		baseRef: 'origin/main',
		headRef: 'HEAD',
		changedFilesMap: {
			'src/app.ts': "@@ -1,1 +1,1 @@\n-console.log('old')\n+console.log('new')",
		},
		commitMessages: 'ABC-123 update app flow',
		jiraDetails: 'Jira context:\nTask: ABC-123',
		reviewRules: ['Prefer guarding null inputs.'],
		focusAreas: ['LogicError', 'Security'],
		batching: {
			enabled: true,
			maxFilesPerBatch: 5,
			maxDiffCharsPerBatch: 40000,
		},
	};

	it('builds a tool-driven prompt with diff and review metadata', () => {
		const prompt = buildReviewPrompt(input);

		expect(prompt).toContain('Scope mode: origin/main..HEAD');
		expect(prompt).toContain('Repository path: /repo');
		expect(prompt).toContain(
			'Use your tools to inspect any needed files, symbols, and surrounding repository context.',
		);
		expect(prompt).toContain('Do not edit files.');
		expect(prompt).toContain('Changed files:');
		expect(prompt).toContain('- src/app.ts');
		expect(prompt).toContain('Commit messages:');
		expect(prompt).toContain('ABC-123 update app flow');
		expect(prompt).toContain('Jira context:\nTask: ABC-123');
		expect(prompt).toContain('Custom rules:\n- Prefer guarding null inputs.');
		expect(prompt).toContain('Git Diff:');
		expect(prompt).toContain('--- src/app.ts ---');
		expect(prompt).not.toContain('Annotated Files:');
	});

	it('filters findings outside the changed file scope', async () => {
		const client = {
			listAgents: async () => ['reviewer', 'general'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>() =>
				({
					issues: [
						{
							filePath: 'src/app.ts',
							lineNumber: 10,
							issueType: 'LogicError',
							comment: 'Real issue',
						},
						{
							filePath: 'src/other.ts',
							lineNumber: 3,
							issueType: 'Security',
							comment: 'Out of scope',
						},
					],
				}) as unknown as T,
			close: async () => {},
		};

		const results = await runReview(client, input);

		expect(results).toEqual({
			'src/app.ts': {
				issues: [
					{
						filePath: 'src/app.ts',
						lineNumber: 10,
						issueType: 'LogicError',
						comment: 'Real issue',
					},
				],
			},
		});
	});

	it('falls back to the built-in general agent when reviewer is unavailable', async () => {
		const client = {
			listAgents: async () => ['general', 'plan'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>(_sessionId: string, options: any) => {
				expect(options.agent).toBe('general');
				expect(options.system).toContain(
					'You are a ready-to-use code reviewer.',
				);
				return { issues: [] } as unknown as T;
			},
			close: async () => {},
		};

		await expect(runReview(client, input)).resolves.toEqual({
			'src/app.ts': { issues: [] },
		});
	});

	it('fails with a clear error when neither reviewer nor general is available', async () => {
		const client = {
			listAgents: async () => ['build', 'plan'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>() => ({ issues: [] }) as unknown as T,
			close: async () => {},
		};

		await expect(runReview(client, input)).rejects.toThrow(
			'OpenCode did not expose the required review agents. Missing "reviewer" and fallback "general". Available agents: build, plan',
		);
	});

	it('falls back to general when agent discovery fails and reviewer is missing at prompt time', async () => {
		const promptStructured = async <T>(_sessionId: string, options: any) => {
			if (options.agent === 'reviewer') {
				throw new Error(
					'OpenCode failed to run a structured prompt: {"name":"UnknownError","data":{"message":"Agent not found: \"reviewer\". Available agents: build, general, plan"}} (500 Internal Server Error)',
				);
			}

			expect(options.agent).toBe('general');
			expect(options.system).toContain('You are a ready-to-use code reviewer.');
			return { issues: [] } as unknown as T;
		};

		const client = {
			listAgents: async () => {
				throw new Error('agents endpoint unavailable');
			},
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured,
			close: async () => {},
		};

		await expect(runReview(client, input)).resolves.toEqual({
			'src/app.ts': { issues: [] },
		});
	});

	it('fails when reviewer output cannot be parsed into structured issues', async () => {
		const client = {
			listAgents: async () => ['reviewer', 'general'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>() =>
				({
					issues: [
						{
							filePath: 'src/app.ts',
							lineNumber: 1,
							issueType: 'NotARealType',
							comment: 'Broken',
						},
					],
				}) as unknown as T,
			close: async () => {},
		};

		await expect(runReview(client, input)).rejects.toThrow();
	});

	it('retries in smaller batches when a larger structured review response fails', async () => {
		const promptStructuredCalls: string[] = [];
		const batchedInput: RunReviewInput = {
			...input,
			changedFilesMap: {
				'src/app.ts':
					"@@ -1,1 +1,1 @@\n-console.log('old')\n+console.log('new')",
				'src/auth.ts':
					'@@ -1,1 +1,1 @@\n-export const oldAuth = true\n+export const newAuth = true',
			},
		};

		const client = {
			listAgents: async () => ['reviewer', 'general'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>(_sessionId: string, options: any) => {
				promptStructuredCalls.push(options.prompt);

				if (
					options.prompt.includes('- src/app.ts') &&
					options.prompt.includes('- src/auth.ts')
				) {
					throw new Error(
						'OpenCode did not return a structured output payload.',
					);
				}

				if (options.prompt.includes('- src/app.ts')) {
					return {
						issues: [
							{
								filePath: 'src/app.ts',
								lineNumber: 10,
								issueType: 'LogicError',
								comment: 'App issue',
							},
						],
					} as unknown as T;
				}

				return {
					issues: [
						{
							filePath: 'src/auth.ts',
							lineNumber: 4,
							issueType: 'Security',
							comment: 'Auth issue',
						},
					],
				} as unknown as T;
			},
			close: async () => {},
		};

		await expect(runReview(client, batchedInput)).resolves.toEqual({
			'src/app.ts': {
				issues: [
					{
						filePath: 'src/app.ts',
						lineNumber: 10,
						issueType: 'LogicError',
						comment: 'App issue',
					},
				],
			},
			'src/auth.ts': {
				issues: [
					{
						filePath: 'src/auth.ts',
						lineNumber: 4,
						issueType: 'Security',
						comment: 'Auth issue',
					},
				],
			},
		});

		expect(promptStructuredCalls).toHaveLength(3);
	});

	it('splits review batches by file count', () => {
		const batches = buildReviewBatches(
			{
				'src/a.ts': 'a',
				'src/b.ts': 'b',
				'src/c.ts': 'c',
			},
			{
				enabled: true,
				maxFilesPerBatch: 2,
				maxDiffCharsPerBatch: 100,
			},
		);

		expect(batches).toEqual([
			{ 'src/a.ts': 'a', 'src/b.ts': 'b' },
			{ 'src/c.ts': 'c' },
		]);
	});

	it('splits review batches by diff size', () => {
		const batches = buildReviewBatches(
			{
				'src/a.ts': '12345',
				'src/b.ts': '67890',
				'src/c.ts': 'abc',
			},
			{
				enabled: true,
				maxFilesPerBatch: 5,
				maxDiffCharsPerBatch: 8,
			},
		);

		expect(batches).toEqual([
			{ 'src/a.ts': '12345' },
			{ 'src/b.ts': '67890', 'src/c.ts': 'abc' },
		]);
	});

	it('no longer depends on annotated file assembly', async () => {
		const reviewerSource = await import('node:fs/promises').then(
			({ readFile }) =>
				readFile(
					new URL('../../src/review/reviewer.ts', import.meta.url),
					'utf8',
				),
		);

		expect(reviewerSource).not.toContain('from "../git/annotate.js"');
		expect(reviewerSource).not.toContain('createAnnotatedFile');
		expect(reviewerSource).not.toContain('Annotated Files:');
	});
});
