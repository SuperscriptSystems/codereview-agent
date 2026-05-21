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
		failOpen: false,
		batching: {
			enabled: true,
			maxBatches: 4,
			maxFilesPerBatch: 5,
		},
		batchTimeoutMs: 120000,
		structuredOutputRetryCount: 10,
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
			getDiagnostics: () => ({ recentServerOutput: '' }),
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
			getDiagnostics: () => ({ recentServerOutput: '' }),
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
			getDiagnostics: () => ({ recentServerOutput: '' }),
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
			getDiagnostics: () => ({ recentServerOutput: '' }),
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
			getDiagnostics: () => ({ recentServerOutput: '' }),
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
			getDiagnostics: () => ({ recentServerOutput: '' }),
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

	it('times out a single review batch', async () => {
		const client = {
			listAgents: async () => ['reviewer', 'general'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>() =>
				await new Promise<T>(() => {
					// Intentionally never resolves.
				}),
			getDiagnostics: () => ({
				recentServerOutput: 'opencode request still running',
			}),
			close: async () => {},
		};

		await expect(
			runReview(client, {
				...input,
				batchTimeoutMs: 20,
			}),
		).rejects.toThrow('Review batch timed out after 20ms (1 files).');
	});

	it('skips a failed batch and continues when fail-open is enabled', async () => {
		const batchedInput: RunReviewInput = {
			...input,
			failOpen: true,
			changedFilesMap: {
				'src/a.ts': 'a',
				'src/b.ts': 'b',
				'src/c.ts': 'c',
			},
			batching: {
				enabled: true,
				maxBatches: 4,
				maxFilesPerBatch: 1,
			},
		};

		const client = {
			listAgents: async () => ['reviewer', 'general'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>(_sessionId: string, options: any) => {
				if (options.prompt.includes('- src/b.ts')) {
					throw new Error('Review batch timed out after 20ms (1 files).');
				}

				const filePath = options.prompt.includes('- src/a.ts')
					? 'src/a.ts'
					: 'src/c.ts';
				return {
					issues: [
						{
							filePath,
							lineNumber: 1,
							issueType: 'LogicError',
							comment: `${filePath} issue`,
						},
					],
				} as unknown as T;
			},
			getDiagnostics: () => ({ recentServerOutput: '' }),
			close: async () => {},
		};

		await expect(runReview(client, batchedInput)).resolves.toEqual({
			'src/a.ts': {
				issues: [
					{
						filePath: 'src/a.ts',
						lineNumber: 1,
						issueType: 'LogicError',
						comment: 'src/a.ts issue',
					},
				],
			},
			'src/b.ts': { issues: [] },
			'src/c.ts': {
				issues: [
					{
						filePath: 'src/c.ts',
						lineNumber: 1,
						issueType: 'LogicError',
						comment: 'src/c.ts issue',
					},
				],
			},
		});
	});

	it('does not return a successful empty review when all fail-open batches fail', async () => {
		const batchedInput: RunReviewInput = {
			...input,
			failOpen: true,
			changedFilesMap: {
				'src/a.ts': 'a',
				'src/b.ts': 'b',
			},
			batching: {
				enabled: true,
				maxBatches: 4,
				maxFilesPerBatch: 1,
			},
		};

		const client = {
			listAgents: async () => ['reviewer', 'general'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>() => {
				throw new Error('OpenCode did not return a structured output payload.');
			},
			getDiagnostics: () => ({ recentServerOutput: '' }),
			close: async () => {},
		};

		await expect(runReview(client, batchedInput)).rejects.toThrow(
			'All review batches failed; refusing to report a successful empty review.',
		);
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
				maxBatches: 4,
				maxFilesPerBatch: 2,
			},
		);

		expect(batches).toEqual([
			{ 'src/a.ts': 'a', 'src/b.ts': 'b' },
			{ 'src/c.ts': 'c' },
		]);
	});

	it('ignores diff size when building batches', () => {
		const batches = buildReviewBatches(
			{
				'src/a.ts': '12345',
				'src/b.ts': '67890',
				'src/c.ts': 'abc',
			},
			{
				enabled: true,
				maxBatches: 4,
				maxFilesPerBatch: 5,
			},
		);

		expect(batches).toEqual([
			{ 'src/a.ts': '12345', 'src/b.ts': '67890', 'src/c.ts': 'abc' },
		]);
	});

	it('processes review batches sequentially', async () => {
		const callOrder: string[] = [];
		let activeCalls = 0;
		let sawParallelCalls = false;
		const batchedInput: RunReviewInput = {
			...input,
			changedFilesMap: {
				'src/a.ts': 'a',
				'src/b.ts': 'b',
				'src/c.ts': 'c',
			},
			batching: {
				enabled: true,
				maxBatches: 4,
				maxFilesPerBatch: 1,
			},
		};

		const client = {
			listAgents: async () => ['reviewer', 'general'],
			createSession: async () => 'session-1',
			promptText: async () => '',
			promptStructured: async <T>(_sessionId: string, options: any) => {
				activeCalls += 1;
				if (activeCalls > 1) {
					sawParallelCalls = true;
				}

				const filePath = options.prompt.includes('- src/a.ts')
					? 'src/a.ts'
					: options.prompt.includes('- src/b.ts')
						? 'src/b.ts'
						: 'src/c.ts';

				callOrder.push(filePath);
				await new Promise(resolve => setTimeout(resolve, 10));
				activeCalls -= 1;

				return {
					issues: [
						{
							filePath,
							lineNumber: 1,
							issueType: 'LogicError',
							comment: `${filePath} issue`,
						},
					],
				} as unknown as T;
			},
			getDiagnostics: () => ({ recentServerOutput: '' }),
			close: async () => {},
		};

		await expect(runReview(client, batchedInput)).resolves.toEqual({
			'src/a.ts': {
				issues: [
					{
						filePath: 'src/a.ts',
						lineNumber: 1,
						issueType: 'LogicError',
						comment: 'src/a.ts issue',
					},
				],
			},
			'src/b.ts': {
				issues: [
					{
						filePath: 'src/b.ts',
						lineNumber: 1,
						issueType: 'LogicError',
						comment: 'src/b.ts issue',
					},
				],
			},
			'src/c.ts': {
				issues: [
					{
						filePath: 'src/c.ts',
						lineNumber: 1,
						issueType: 'LogicError',
						comment: 'src/c.ts issue',
					},
				],
			},
		});

		expect(sawParallelCalls).toBe(false);
		expect(callOrder).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
	});

	it('caps review batches to the configured maximum', () => {
		const batches = buildReviewBatches(
			{
				'src/1.ts': '1',
				'src/2.ts': '2',
				'src/3.ts': '3',
				'src/4.ts': '4',
				'src/5.ts': '5',
				'src/6.ts': '6',
			},
			{
				enabled: true,
				maxBatches: 4,
				maxFilesPerBatch: 1,
			},
		);

		expect(batches).toHaveLength(4);
		expect(batches).toEqual([
			{ 'src/1.ts': '1', 'src/2.ts': '2' },
			{ 'src/3.ts': '3', 'src/4.ts': '4' },
			{ 'src/5.ts': '5' },
			{ 'src/6.ts': '6' },
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
