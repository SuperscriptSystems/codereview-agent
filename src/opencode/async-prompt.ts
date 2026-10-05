import { randomBytes } from 'node:crypto';
import type { OpencodeClient } from '@opencode-ai/sdk';

import { logger } from '../core/logger.js';
import {
	formatRecentServerOutput,
	formatTransportError,
	runRequest,
	waitForDelay,
} from './request.js';

export const defaultPromptTimeoutMs = 600_000;

interface PromptOptions {
	signal?: AbortSignal;
	label: string;
	getRecentServerOutput?: () => string;
	pollIntervalMs?: number;
	cleanupSignal?: AbortSignal;
}

type Message = {
	info: {
		id: string;
		role: string;
		parentID?: string;
		finish?: string;
		structured?: unknown;
		structured_output?: unknown;
		format?: unknown;
		time?: { completed?: number };
		error?: { name?: string; message?: string; data?: { message?: string } };
	};
	parts: Array<{ id?: string; messageID?: string; type: string; text?: string; tool?: string; state?: { status?: string } }>;
};

/** Submit one turn once; a lost HTTP response must never enqueue the prompt again. */
export async function runAsyncPrompt(
	client: OpencodeClient,
	sessionId: string,
	body: Record<string, unknown>,
	options: PromptOptions,
): Promise<{ data: Message }> {
	const controller = new AbortController();
	const timer = options.signal
		? undefined
		: setTimeout(() => {
				controller.abort(
					new Error(
						`${options.label} timed out after ${defaultPromptTimeoutMs}ms.`,
					),
				);
			}, defaultPromptTimeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	const messageId = `msg_${(BigInt(Date.now()) * 4096n).toString(16).padStart(12, '0')}${randomBytes(7).toString('hex')}`;
	const startedAt = Date.now();
	const observer = observeSessionErrors(client, sessionId, messageId, signal, error =>
		controller.abort(error),
	);
	try {
		await runRequest(() => observer.ready, {
			...options,
			signal,
			label: 'OpenCode event stream connection',
			retry: false,
		});
		observer.throwIfFailed();
		const accepted = await runRequest(
			requestSignal =>
				client.session.promptAsync({
					path: { id: sessionId },
					signal: requestSignal,
					body: { ...body, messageID: messageId } as Parameters<
						typeof client.session.promptAsync
					>[0]['body'],
				}),
			{ ...options, signal, retry: false },
		);
		assertResponse(accepted, 'submit async prompt');
		logger.info(
			`${options.label} accepted; session ${sessionId}, message ${messageId}.`,
		);
		let lastProgressAt = 0;
		let useEventsOnly = false;
		while (true) {
			signal.throwIfAborted();
			observer.throwIfFailed();
			const statusResponse = await runRequest(
				requestSignal => client.session.status({ signal: requestSignal }),
				{ ...options, signal, label: 'OpenCode session status', quiet: true },
			);
			const statuses = assertResponse(
				statusResponse,
				'read session status',
			) as Record<string, { type: string; attempt?: number; message?: string }>;
			if (!statuses || typeof statuses !== 'object') {
				throw new Error('OpenCode returned an invalid async session state.');
			}
			const status = statuses[sessionId];
			const reportProgress = Date.now() - lastProgressAt >= 30_000;
			// Tool outputs can be large; fetch message history only for progress or completion.
			if (status?.type === 'busy' || status?.type === 'retry') {
				if (!reportProgress) {
					await waitForDelay(options.pollIntervalMs ?? 1000, signal);
					continue;
				}
			}
			let messages = observer.messages();
			if (messages.length === 0 && !useEventsOnly) {
				try {
					const messageResponse = await runRequest(
						requestSignal => client.session.messages({ path: { id: sessionId }, signal: requestSignal }),
						{ ...options, signal, label: 'OpenCode session messages', quiet: true },
					);
					messages = assertResponse(messageResponse, 'read session messages') as Message[];
					if (!Array.isArray(messages)) throw new Error('OpenCode returned invalid session messages.');
				} catch (error) {
					// OpenCode 1.18.x cannot encode persisted OutputFormatJsonSchema on message GET.
					// Native SSE events retain the same schema and results without that wire codec.
					if (!(error instanceof Error) || !error.message.includes('Expected OutputFormatJsonSchema')) throw error;
					useEventsOnly = true;
					logger.info('OpenCode message-list JSON schema codec is incompatible; reading the current turn from native session events.');
					messages = observer.messages();
				}
			}
			observer.throwIfFailed();
			if (body.noReply === true && (!status || status.type === 'idle')) {
				const user = messages.find(message => message.info.role === 'user' && message.info.id === messageId);
				if (user && user.parts.length > 0) return { data: user };
			}
			// Other turns (including an earlier JSON fallback) cannot satisfy this request.
			const matching = messages.filter(
				message =>
					message.info.role === 'assistant' &&
				message.info.parentID === messageId,
			);
			const latest = matching.at(-1);
			if ((!status || status.type === 'idle') && latest?.info.time?.completed) {
				if (latest.info.error) {
					throw new Error(
						latest.info.error.message ??
							latest.info.error.data?.message ??
							latest.info.error.name ??
							'OpenCode async prompt failed.',
					);
				}
				// Tool-call messages complete individually while the agent continues working.
				if (
					latest.info.structured !== undefined ||
					latest.info.structured_output !== undefined ||
					(latest.info.finish &&
						!['tool-calls', 'unknown'].includes(latest.info.finish))
				) {
					logger.info(
						`${options.label} completed in ${Date.now() - startedAt}ms.`,
					);
					return { data: latest };
				}
			}
			if (reportProgress) {
				const tools =
					latest?.parts
						.filter(part => part.type === 'tool')
						.map(part => `${part.tool}:${part.state?.status}`) ?? [];
				logger.info(
					`${options.label} pending for ${Date.now() - startedAt}ms: state=${status?.type ?? 'waiting'}, assistant turns=${matching.length}${tools.length ? `, tools=${tools.join(', ')}` : ''}${status?.type === 'retry' ? `, provider retry=${status.attempt}, reason=${formatTransportError(status.message ?? '')}` : ''}.`,
				);
				lastProgressAt = Date.now();
			}
			await waitForDelay(options.pollIntervalMs ?? 1000, signal);
		}
	} catch (error) {
		logger.warn(
			`${options.label} failed after ${Date.now() - startedAt}ms: ${formatTransportError(error)}.`,
		);
		const output = formatRecentServerOutput(
			options.getRecentServerOutput?.() ?? '',
		);
		if (output)
			logger.warn(`${options.label} recent server output:\n${output}`);
		// The server may have accepted a request even if its acknowledgement was lost.
		await runRequest(
			requestSignal =>
				client.session.abort({
					path: { id: sessionId },
					signal: requestSignal,
				}),
			{
				label: 'OpenCode async session abort',
				signal: options.cleanupSignal,
				timeoutMs: 5000,
				retry: false,
				quiet: true,
			},
		).catch(() => {});
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		controller.abort();
	}
}

function assertResponse(response: unknown, action: string): unknown {
	const result = response as {
		data?: unknown;
		error?: unknown;
		response?: { status?: number };
	};
	if (result?.error) {
		const detail = result.error instanceof Error ? result.error.message : JSON.stringify(result.error);
		throw new Error(
			`OpenCode failed to ${action}: ${detail}${result.response?.status ? ` (HTTP ${result.response.status})` : ''}`,
		);
	}
	return result?.data;
}

function observeSessionErrors(
	client: OpencodeClient,
	sessionId: string,
	messageId: string,
	signal: AbortSignal,
	onFailure: (error: unknown) => void,
) {
	let failure: unknown;
	let resolveReady!: () => void;
	let rejectReady!: (error: unknown) => void;
	let user: Message | undefined;
	let assistant: Message | undefined;
	const parts = new Map<string, Message['parts'][number]>();
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const fail = (error: unknown) => {
		if (signal.aborted) return;
		failure = error;
		rejectReady(error);
		onFailure(error);
	};
	void ready.catch(() => {});
	void (async () => {
		const events = await client.event.subscribe({
			signal,
			sseMaxRetryAttempts: 1,
			onSseError: fail,
		});
		for await (const event of events.stream) {
			if (signal.aborted) break;
			if (event.type === 'server.connected') resolveReady();
			if (
				event.type === 'session.error' &&
				event.properties.sessionID === sessionId
			) {
				fail(
					new Error(
						`OpenCode async prompt failed: ${JSON.stringify(event.properties.error)}`,
					),
				);
			}
			if (event.type === 'message.updated') {
				const info = event.properties.info as unknown as Message['info'] & { sessionID: string; time: { created: number; completed?: number } };
				if (info.sessionID !== sessionId) continue;
				if (info.role === 'user' && info.id === messageId) user = { info, parts: [] };
				if (info.role === 'assistant' && info.parentID === messageId) {
					const previousCreated = (assistant?.info.time as { created?: number } | undefined)?.created ?? 0;
					if (!assistant || info.id === assistant.info.id || info.time.created > previousCreated ||
						(info.time.created === previousCreated && info.id > assistant.info.id)) {
						if (assistant && assistant.info.id !== info.id) {
							for (const [id, part] of parts) if (part.messageID === assistant.info.id) parts.delete(id);
						}
						assistant = { info, parts: [] };
					}
				}
			}
			if (event.type === 'message.part.updated') {
				const part = event.properties.part;
				if (part.sessionID !== sessionId || (part.messageID !== messageId && part.messageID !== assistant?.info.id)) continue;
				if (part.type === 'text') parts.set(part.id, { id: part.id, messageID: part.messageID, type: 'text', text: part.text });
				if (part.type === 'tool') parts.set(part.id, { id: part.id, messageID: part.messageID, type: 'tool', tool: part.tool, state: { status: part.state.status } });
			}
			// Some server versions stream text increments between full part updates.
			const deltaEvent = event as unknown as { type: string; properties: { sessionID?: string; partID?: string; field?: string; delta?: string } };
			if (deltaEvent.type === 'message.part.delta' && deltaEvent.properties.sessionID === sessionId && deltaEvent.properties.field === 'text') {
				const part = parts.get(deltaEvent.properties.partID ?? '');
				if (part?.type === 'text') part.text = (part.text ?? '') + (deltaEvent.properties.delta ?? '');
			}
		}
		if (!signal.aborted)
			fail(
				new Error('OpenCode event stream closed before the prompt finished.'),
			);
	})().catch(fail);
	return {
		ready,
		messages: () => [user, assistant].filter((message): message is Message => Boolean(message))
			.map(message => ({ info: message.info, parts: [...parts.values()].filter(part => part.messageID === message.info.id) })),
		throwIfFailed: () => {
			if (failure) throw failure;
		},
	};
}
