import { describe, expect, it } from 'vitest';

import { __test__ } from '../../src/opencode/client.js';

describe('opencode client structured output extraction', () => {
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
		expect(prompt).toContain('"issues"');
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
});
