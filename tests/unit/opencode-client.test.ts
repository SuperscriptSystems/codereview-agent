import { describe, expect, it, vi } from 'vitest';

import { __test__ } from '../../src/opencode/client.js';

describe('opencode client structured output extraction', () => {
	it('shows the underlying transport timeout code without exposing credentials', () => {
		const previousKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = 'test-secret-key';
		try {
			const cause = Object.assign(
				new Error('connection to test-secret-key timed out'),
				{ name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
			);
			const error = new TypeError('fetch failed', { cause });
			expect(__test__.formatTransportError(error)).toBe(
				'TypeError: fetch failed <- caused by ConnectTimeoutError: connection to [REDACTED] timed out (code: UND_ERR_CONNECT_TIMEOUT)',
			);
		} finally {
			if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousKey;
		}
	});

	it('logs structured prompt retry timing and redacted server output on transport failure', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const info = vi.spyOn(console, 'log').mockImplementation(() => {});
		const previousKey = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = 'test-secret-key';
		try {
			const transportError = new TypeError('fetch failed', {
				cause: Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' }),
			});
			const operation = vi.fn()
				.mockRejectedValueOnce(transportError)
				.mockResolvedValue({ ok: true });
			await expect(__test__.withTransportRetry(operation, {
				label: 'OpenCode structured prompt',
				getRecentServerOutput: () => 'upstream error test-secret-key',
			})).resolves.toEqual({ ok: true });
			expect(operation).toHaveBeenCalledTimes(2);
			expect(info).toHaveBeenCalledWith(expect.stringMatching(/OpenCode structured prompt attempt 1\/3 started at .*Z\./));
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/OpenCode structured prompt attempt 1\/3 failed after \d+ms: TypeError: fetch failed <- caused by socket timed out \(code: ETIMEDOUT\)/));
			expect(warn).toHaveBeenCalledWith('[warn] OpenCode structured prompt recent server output:\nupstream error [REDACTED]');
		} finally {
			if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousKey;
			warn.mockRestore();
			info.mockRestore();
		}
	});
	it('reads structured output from v2 info.structured', () => {
		expect(
			__test__.getStructuredOutputInfo({
				info: {
					structured: { issues: [] },
				},
			}),
		).toEqual({
			structured_output: { issues: [] },
			error: undefined,
		});
	});

	it('reads structured output from wrapped data.info.structured', () => {
		expect(
			__test__.getStructuredOutputInfo({
				data: {
					info: {
						structured: { issues: [] },
					},
				},
			}),
		).toEqual({
			structured_output: { issues: [] },
			error: undefined,
		});
	});

	it('normalizes StructuredOutputError message from nested data.message', () => {
		expect(
			__test__.getStructuredOutputInfo({
				info: {
					error: {
						name: 'StructuredOutputError',
						data: { message: 'schema validation failed' },
					},
				},
			}),
		).toEqual({
			structured_output: undefined,
			error: {
				name: 'StructuredOutputError',
				message: 'schema validation failed',
			},
		});
	});

	it('extracts structured payload from text parts when info.structured_output is missing', () => {
		expect(
			__test__.extractStructuredPayloadFromText<{ issues: unknown[] }>({
				data: {
					parts: [
						{
							type: 'text',
							text: '```json\n{"issues":[]}\n```',
						},
					],
				},
			}),
		).toEqual({ issues: [] });
	});

	it('extracts text from wrapped response parts', () => {
		expect(
			__test__.extractPromptText({
				data: {
					parts: [
						{ type: 'text', text: 'first' },
						{ type: 'tool', text: 'ignored' },
						{ type: 'text', text: 'second' },
					],
				},
			}),
		).toBe('first\nsecond');
	});

	it('extracts structured payload from latest assistant session message', () => {
		expect(
			__test__.extractStructuredPayloadFromSessionMessages<{
				issues: unknown[];
			}>({
				data: [
					{
						info: { role: 'user' },
						parts: [
							{
								type: 'text',
								text: 'Required schema: {"issues":{"type":"array"}}',
							},
						],
					},
					{
						info: { role: 'assistant' },
						parts: [
							{
								type: 'text',
								text: 'BEGIN_JSON\n{"issues":[]}\nEND_JSON',
							},
						],
					},
				],
			}),
		).toEqual({ issues: [] });
	});

	it('polls session messages until the assistant payload is available', async () => {
		const messages = vi
			.fn()
			.mockResolvedValueOnce({
				data: [
					{
						info: { role: 'assistant', time: {} },
						parts: [],
					},
				],
			})
			.mockResolvedValueOnce({
				data: [
					{
						info: {
							role: 'assistant',
							time: { completed: 123 },
						},
						parts: [
							{
								type: 'text',
								text: 'BEGIN_JSON\n{"issues":[]}\nEND_JSON',
							},
						],
					},
				],
			});

		await expect(
			__test__.extractStructuredPayloadFromSession<{ issues: unknown[] }>(
				{ session: { messages } } as any,
				'http://127.0.0.1:4096',
				'session-1',
				{
					type: 'object',
					properties: { issues: { type: 'array' } },
				},
			),
		).resolves.toEqual({ issues: [] });
		expect(messages).toHaveBeenCalledTimes(2);
	});

	it('describes latest assistant message state for structured failures', () => {
		expect(
			__test__.describeSessionMessages({
				data: [
					{
						info: { role: 'user', time: { completed: 1 } },
						parts: [{ type: 'text', text: 'review this' }],
					},
					{
						info: {
							role: 'assistant',
							time: { completed: 2 },
							finish: 'stop',
						},
						parts: [{ type: 'text', text: 'I could not format JSON.' }],
					},
				],
			}),
		).toContain('messages=2, assistant completed=true, finish=stop');
	});

	it('describes session message endpoint errors', () => {
		expect(
			__test__.describeSessionMessages({
				error: {
					message: 'Raw session messages request failed: 404 Not Found',
					body: { message: 'missing route' },
					sdkResponse: { status: 404, error: 'Not Found' },
				},
			}),
		).toContain('Raw session messages request failed: 404 Not Found');
	});

	it('normalizes plain-text no-findings review responses to an empty issues payload', () => {
		expect(
			__test__.extractNoIssuesPayloadFromText<{ issues: unknown[] }>(
				{
					data: {
						parts: [
							{
								type: 'text',
								text: 'No issues found in this frontend-only change.',
							},
						],
					},
				},
				{
					type: 'object',
					properties: { issues: { type: 'array' } },
					required: ['issues'],
				},
			),
		).toEqual({ issues: [] });
	});

	it('does not normalize no-findings prose for non-review schemas', () => {
		expect(
			__test__.extractNoIssuesPayloadFromText(
				{
					data: {
						parts: [{ type: 'text', text: 'No issues found.' }],
					},
				},
				{
					type: 'object',
					properties: { reasoning: { type: 'string' } },
				},
			),
		).toBeNull();
	});

	it('builds a marker-based retry prompt for plain-text structured fallback', () => {
		const prompt = __test__.buildStructuredJsonRetryPrompt(
			'Review this diff.',
			{
				type: 'object',
				properties: {
					issues: {
						type: 'array',
					},
				},
			},
		);

		expect(prompt).toContain(
			'Your previous response did not produce a structured payload.',
		);
		expect(prompt).toContain('BEGIN_JSON');
		expect(prompt).toContain('END_JSON');
		expect(prompt).toContain('empty arrays instead of prose');
		expect(prompt).toContain('"issues"');
	});

	it('extracts OpenCode error messages from nested error data', () => {
		expect(
			__test__.getResponseErrorMessage({
				error: {
					name: 'BadRequest',
					data: {
						message: 'Expected OutputFormatJsonSchema',
					},
				},
			}),
		).toBe('Expected OutputFormatJsonSchema');
	});

	it('detects retryable transport failures', () => {
		expect(
			__test__.isRetryableTransportError(new TypeError('fetch failed')),
		).toBe(true);
		expect(
			__test__.isRetryableTransportError(new Error('socket hang up')),
		).toBe(true);
		expect(
			__test__.isRetryableTransportError(new Error('schema validation failed')),
		).toBe(false);
	});

	it('starts opencode server with project config disabled and explicit config content', () => {
		const env = __test__.buildOpencodeServerEnv(
			{ OPENAI_API_KEY: 'test-key' },
			{ model: 'openai/reviewer-model' },
		);

		expect(env).toMatchObject({
			OPENAI_API_KEY: 'test-key',
			OPENCODE_DISABLE_PROJECT_CONFIG: '1',
			OPENCODE_SERVER_PASSWORD: '',
			OPENCODE_SERVER_USERNAME: '',
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				model: 'openai/reviewer-model',
			}),
		});
	});
});
