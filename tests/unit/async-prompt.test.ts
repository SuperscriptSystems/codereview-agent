import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createOpencodeClient } from '@opencode-ai/sdk';
import { runAsyncPrompt } from '../../src/opencode/async-prompt.js';
import { runRequest, waitForDelay } from '../../src/opencode/request.js';
import { reviewIssuesEnvelopeJsonSchema } from '../../src/core/models.js';

function makeClient(eventError?: string) {
	let currentMessageId = '';
	let resolveSubmitted!: () => void;
	const submitted = new Promise<void>(resolve => {
		resolveSubmitted = resolve;
	});
	const client = {
		event: {
			subscribe: vi.fn(async ({ signal }: { signal: AbortSignal }) => ({
				stream: (async function* () {
					yield { type: 'server.connected', properties: {} };
					if (eventError) {
						await submitted;
						yield {
							type: 'session.error',
							properties: {
								sessionID: 'session-1',
								error: { name: 'UnknownError', data: { message: eventError } },
							},
						};
					}
					if (!signal.aborted)
						await new Promise<void>(resolve =>
							signal.addEventListener('abort', () => resolve(), { once: true }),
						);
				})(),
			})),
		},
		session: {
			promptAsync: vi.fn(async ({ body }: any) => {
				currentMessageId = body.messageID;
				resolveSubmitted();
				return { response: { status: 204 } };
			}),
			messages: vi.fn(async () => ({ data: [result()] })),
			status: vi.fn(async () => ({ data: { 'session-1': { type: 'idle' } } })),
			abort: vi.fn(async () => ({ data: true })),
		},
	};
	function result(overrides: Record<string, unknown> = {}) {
		return {
			info: {
				id: 'msg-assistant',
				role: 'assistant',
				parentID: currentMessageId,
				time: { completed: 1 },
				finish: 'stop',
				structured: { issues: [] },
				...overrides,
			},
			parts: [],
		};
	}
	return { client, result };
}

describe('async OpenCode prompts', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	const options = { label: 'OpenCode structured prompt', pollIntervalMs: 1 };
	const body = {
		agent: 'reviewer',
		parts: [
			{
				type: 'text',
				text: 'Review diff.\n<BEGIN_REPOSITORY_INSTRUCTIONS>\nCheck Team isolation.\n<END_REPOSITORY_INSTRUCTIONS>',
			},
		],
		format: {
			type: 'json_schema',
			retryCount: 4,
			schema: reviewIssuesEnvelopeJsonSchema,
		},
	};

	it('submits the schema and project instructions once and returns structured output', async () => {
		const { client } = makeClient();
		const response = await runAsyncPrompt(
			client as any,
			'session-1',
			body,
			options,
		);
		expect(response.data.info.structured).toEqual({ issues: [] });
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
		expect(client.session.promptAsync.mock.calls[0][0].body).toMatchObject(
			body,
		);
		expect(client.session.promptAsync.mock.calls[0][0].body.messageID).toMatch(
			/^msg_/,
		);
		expect(client.event.subscribe.mock.calls[0][0].signal.aborted).toBe(true);
	});

	it('ignores earlier turns and completed tool calls until this turn finishes', async () => {
		const { client, result } = makeClient();
		client.session.messages
			.mockImplementationOnce(async () => ({
				data: [
					result({ parentID: 'old-turn', structured: { issues: ['stale'] } }),
				],
			}))
			.mockImplementationOnce(async () => ({
				data: [result({ finish: 'tool-calls', structured: undefined })],
			}));
		await expect(
			runAsyncPrompt(client as any, 'session-1', body, options),
		).resolves.toMatchObject({
			data: { info: { structured: { issues: [] } } },
		});
		expect(client.session.messages).toHaveBeenCalledTimes(3);
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
	});

	it('does not finish while the session is busy even if structured data is already present', async () => {
		const { client } = makeClient();
		client.session.status.mockResolvedValueOnce({
			data: { 'session-1': { type: 'busy' } },
		});
		await runAsyncPrompt(client as any, 'session-1', body, options);
		expect(client.session.messages).toHaveBeenCalledTimes(2);
	});

	it('waits beyond 300 seconds without resubmitting the prompt', async () => {
		vi.useFakeTimers();
		const { client, result } = makeClient();
		const startedAt = Date.now();
		client.session.messages.mockImplementation(async () => ({
			data: Date.now() - startedAt > 300_000 ? [result()] : [],
		}));
		client.session.status.mockImplementation(async () => ({
			data: {
				'session-1': {
					type: Date.now() - startedAt > 300_000 ? 'idle' : 'busy',
				},
			},
		}));
		const promise = runAsyncPrompt(client as any, 'session-1', body, {
			...options,
			pollIntervalMs: 1000,
		});
		const assertion = expect(promise).resolves.toMatchObject({
			data: { info: { structured: { issues: [] } } },
		});
		await vi.advanceTimersByTimeAsync(302_000);
		await assertion;
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
		expect(client.session.messages.mock.calls.length).toBeLessThan(15);
	});

	it('does not retry a prompt when its acknowledgement is lost', async () => {
		const { client } = makeClient();
		client.session.promptAsync.mockRejectedValue(new TypeError('fetch failed'));
		await expect(
			runAsyncPrompt(client as any, 'session-1', body, options),
		).rejects.toThrow('fetch failed');
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
		expect(client.session.abort).toHaveBeenCalledTimes(1);
	});

	it('retries a failed status read without sending the prompt again', async () => {
		const { client } = makeClient();
		client.session.status.mockRejectedValueOnce(new TypeError('fetch failed'));
		await runAsyncPrompt(client as any, 'session-1', body, options);
		expect(client.session.status).toHaveBeenCalledTimes(2);
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
	});

	it('propagates session.error events, including a missing reviewer', async () => {
		const { client } = makeClient('Agent not found: "reviewer"');
		await expect(
			runAsyncPrompt(client as any, 'session-1', body, options),
		).rejects.toThrow('Agent not found');
		expect(client.session.promptAsync).toHaveBeenCalledTimes(1);
		expect(client.session.abort).toHaveBeenCalledTimes(1);
	});

	it('cancels polling and aborts the server session', async () => {
		const { client } = makeClient();
		const controller = new AbortController();
		client.session.messages.mockResolvedValue({ data: [] });
		const promise = runAsyncPrompt(client as any, 'session-1', body, {
			...options,
			signal: controller.signal,
			pollIntervalMs: 1000,
		});
		const assertion = expect(promise).rejects.toThrow('Total review timeout');
		await vi.waitFor(() => expect(client.session.messages).toHaveBeenCalled());
		controller.abort(new Error('Total review timeout'));
		await assertion;
		const calls = client.session.messages.mock.calls.length;
		await new Promise(resolve => setTimeout(resolve, 5));
		expect(client.session.messages).toHaveBeenCalledTimes(calls);
		expect(client.session.abort).toHaveBeenCalledTimes(1);
	});

	it('does not issue cleanup requests after the client has closed', async () => {
		const { client } = makeClient();
		const lifetime = new AbortController();
		client.session.messages.mockResolvedValue({ data: [] });
		const promise = runAsyncPrompt(client as any, 'session-1', body, {
			...options,
			signal: lifetime.signal,
			cleanupSignal: lifetime.signal,
			pollIntervalMs: 1000,
		});
		const assertion = expect(promise).rejects.toThrow('OpenCode client closed');
		await vi.waitFor(() => expect(client.session.messages).toHaveBeenCalled());
		lifetime.abort(new Error('OpenCode client closed'));
		await assertion;
		expect(client.session.abort).not.toHaveBeenCalled();
		expect(client.event.subscribe.mock.calls[0][0].signal.aborted).toBe(true);
	});

	it('sends the async schema through the real SDK and preserves repository routing', async () => {
		let submitted: any;
		let submissions = 0;
		const directories: string[] = [];
		const server = createServer(async (request, response) => {
			const url = new URL(request.url!, 'http://localhost');
			directories.push(
				url.searchParams.get('directory') ??
					decodeURIComponent(String(request.headers['x-opencode-directory'])),
			);
			if (url.pathname === '/event') {
				response.writeHead(200, { 'Content-Type': 'text/event-stream' });
				response.write('data: {"type":"server.connected","properties":{}}\n\n');
				return;
			}
			if (url.pathname === '/session/session-1/prompt_async') {
				let text = '';
				for await (const chunk of request) text += chunk;
				submitted = JSON.parse(text);
				submissions += 1;
				response.writeHead(204).end();
				return;
			}
			response.setHeader('Content-Type', 'application/json');
			if (url.pathname === '/session/status') {
				response.end('{}');
				return;
			}
			if (url.pathname === '/session/session-1/message') {
				response.end(
					JSON.stringify([
						{
							info: {
								id: 'msg-output',
								role: 'assistant',
								parentID: submitted.messageID,
								time: { completed: 1 },
								finish: 'tool-calls',
								structured: { issues: [] },
							},
							parts: [],
						},
					]),
				);
				return;
			}
			response
				.writeHead(404)
				.end(JSON.stringify({ unexpectedPath: request.url }));
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const address = server.address() as { port: number };
			const client = createOpencodeClient({
				baseUrl: `http://127.0.0.1:${address.port}`,
				directory: '/repo',
			});
			await expect(
				runAsyncPrompt(client, 'session-1', body, options),
			).resolves.toMatchObject({
				data: { info: { structured: { issues: [] } } },
			});
			expect(submissions).toBe(1);
			expect(submitted).toMatchObject(body);
			expect(directories.every(directory => directory === '/repo')).toBe(true);
		} finally {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});

describe('bounded OpenCode requests', () => {
	afterEach(() => vi.useRealTimers());
	it('limits an unresponsive request and aborts its signal', async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const promise = runRequest(
			requestSignal => {
				signal = requestSignal;
				return new Promise(() => {});
			},
			{ label: 'createSession', timeoutMs: 50, retry: false },
		);
		const assertion = expect(promise).rejects.toThrow(
			'createSession timed out after 50ms',
		);
		await vi.advanceTimersByTimeAsync(50);
		await assertion;
		expect(signal?.aborted).toBe(true);
	});

	it('stops retries when cancelled during backoff', async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const operation = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
		const promise = runRequest(operation, {
			label: 'read status',
			signal: controller.signal,
		});
		const assertion = expect(promise).rejects.toThrow('Cancelled');
		await vi.advanceTimersByTimeAsync(1);
		controller.abort(new Error('Cancelled'));
		await assertion;
		await vi.advanceTimersByTimeAsync(1000);
		expect(operation).toHaveBeenCalledTimes(1);
	});

	it('rejects an already cancelled delay without scheduling another operation', async () => {
		const signal = AbortSignal.abort(new Error('Cancelled'));
		expect(() => waitForDelay(1000, signal)).toThrow('Cancelled');
	});
});
