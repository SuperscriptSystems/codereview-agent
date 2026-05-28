import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { logger } from '../core/logger.js';

const transportRetryAttempts = 3;
const transportRetryBaseDelayMs = 500;
const structuredSessionPollAttempts = 12;
const structuredSessionPollDelayMs = 500;

export interface OpencodeSessionClient {
	createSession(title: string): Promise<string>;
	listAgents(): Promise<string[]>;
	promptText(
		sessionId: string,
		options: { agent: string; system?: string; prompt: string },
	): Promise<string>;
	promptStructured<T>(
		sessionId: string,
		options: {
			agent: string;
			system?: string;
			prompt: string;
			schema: Record<string, unknown>;
			retryCount?: number;
		},
	): Promise<T>;
	getDiagnostics(): { recentServerOutput: string };
	close(): Promise<void>;
}

export async function createSessionClient(
	config: Record<string, unknown>,
	directory?: string,
): Promise<OpencodeSessionClient> {
	const port = await getAvailablePort();
	const server = await startIsolatedOpencodeServer(
		sanitizeOpencodeServerConfig(config),
		port,
	);
	const client = createOpencodeClient({
		baseUrl: server.url,
		directory,
	});
	const baseUrl = server.url;

	return {
		async createSession(title: string): Promise<string> {
			const response = await withTransportRetry(() =>
				client.session.create({
					body: { title },
				}),
			);
			const data = getResponseData<{ id?: string }>(response);

			if (!data?.id) {
				throw new Error(
					buildOpencodeErrorMessage(
						'create a session',
						response,
						'OpenCode did not return a session payload.',
					),
				);
			}

			return data.id;
		},
		async listAgents(): Promise<string[]> {
			const response = await withTransportRetry(() => client.app.agents());
			const data = getResponseData<Array<{ name?: string }>>(response);

			if (!Array.isArray(data)) {
				throw new Error(
					buildOpencodeErrorMessage(
						'list available agents',
						response,
						'OpenCode did not return an agent list payload.',
					),
				);
			}

			return data
				.flatMap(agent => (typeof agent?.name === 'string' ? [agent.name] : []))
				.sort((left, right) => left.localeCompare(right));
		},
		async promptText(
			sessionId: string,
			options: { agent: string; system?: string; prompt: string },
		): Promise<string> {
			const response = await withTransportRetry<
				Awaited<ReturnType<typeof client.session.prompt>>
			>(() =>
				client.session.prompt({
					path: { id: sessionId },
					body: {
						agent: options.agent,
						system: options.system,
						parts: [{ type: 'text', text: options.prompt }],
					},
				}),
			);
			const data = getResponseData<{
				parts?: Array<{ type: string; text?: string }>;
			}>(response);

			if (!data?.parts) {
				throw new Error(
					buildOpencodeErrorMessage(
						'run a prompt',
						response,
						'OpenCode did not return a prompt response payload.',
					),
				);
			}

			return extractTextFromParts(data.parts);
		},
		async promptStructured<T>(
			sessionId: string,
			options: {
				agent: string;
				system?: string;
				prompt: string;
				schema: Record<string, unknown>;
				retryCount?: number;
			},
		): Promise<T> {
			// The OpenCode server accepts `format` for structured output, but the SDK type here lags behind the API.
			const response = await withTransportRetry<
				Awaited<ReturnType<typeof client.session.prompt>>
			>(() =>
				client.session.prompt({
					path: { id: sessionId },
					body: {
						agent: options.agent,
						system: options.system,
						parts: [{ type: 'text', text: options.prompt }],
						format: {
							type: 'json_schema',
							retryCount: options.retryCount ?? 3,
							schema: options.schema,
						},
					} as unknown as Parameters<typeof client.session.prompt>[0]['body'],
				} as Parameters<typeof client.session.prompt>[0]),
			);

			const info = getStructuredOutputInfo(response);
			if (info?.error?.name === 'StructuredOutputError') {
				throw new Error(
					info.error.message ?? 'OpenCode structured output validation failed.',
				);
			}

			const textFallback = extractStructuredPayloadFromText<T>(response);
			if (textFallback !== null) {
				return textFallback;
			}

			const noIssuesTextFallback = extractNoIssuesPayloadFromText<T>(
				response,
				options.schema,
			);
			if (noIssuesTextFallback !== null) {
				return noIssuesTextFallback;
			}

			const sessionFallback = await extractStructuredPayloadFromSession<T>(
				client,
				baseUrl,
				sessionId,
				options.schema,
			);
			if (sessionFallback !== null) {
				return sessionFallback;
			}

			const plainTextFallback = await promptStructuredViaTextFallback<T>(
				client,
				baseUrl,
				sessionId,
				options,
			);
			if (plainTextFallback !== null) {
				return plainTextFallback;
			}

			if (info?.structured_output === undefined) {
				const promptText = extractPromptText(response);
				const sessionDetails = await describeSessionStructuredState(
					client,
					baseUrl,
					sessionId,
				);
				const details = promptText
					? ` Raw response text: ${truncateText(promptText, 400)}`
					: '';
				throw new Error(
					buildOpencodeErrorMessage(
						'run a structured prompt',
						response,
						`OpenCode did not return a structured output payload.${details}${sessionDetails ? ` Session state: ${sessionDetails}` : ''}`,
					),
				);
			}

			return info.structured_output as T;
		},
		async close(): Promise<void> {
			await server.close();
		},
		getDiagnostics(): { recentServerOutput: string } {
			return { recentServerOutput: server.getRecentOutput() };
		},
	};
}

async function promptStructuredViaTextFallback<T>(
	client: OpencodeClient,
	baseUrl: string,
	sessionId: string,
	options: {
		agent: string;
		system?: string;
		prompt: string;
		schema: Record<string, unknown>;
	},
): Promise<T | null> {
	const startedAt = Date.now();
	logger.info(
		'Structured output missing, retrying with plain-text JSON fallback.',
	);
	const response = await withTransportRetry<
		Awaited<ReturnType<typeof client.session.prompt>>
	>(() =>
		client.session.prompt({
			path: { id: sessionId },
			body: {
				agent: options.agent,
				system: options.system,
				parts: [
					{
						type: 'text',
						text: buildStructuredJsonRetryPrompt(
							options.prompt,
							options.schema,
						),
					},
				],
			},
		}),
	);
	logger.info(
		`Plain-text structured fallback completed in ${Date.now() - startedAt}ms.`,
	);

	const responsePayload = extractStructuredPayloadFromText<T>(response);
	if (responsePayload !== null) {
		return responsePayload;
	}

	const noIssuesPayload = extractNoIssuesPayloadFromText<T>(
		response,
		options.schema,
	);
	if (noIssuesPayload !== null) {
		return noIssuesPayload;
	}

	return await extractStructuredPayloadFromSession<T>(
		client,
		baseUrl,
		sessionId,
		options.schema,
	);
}

async function extractStructuredPayloadFromSession<T>(
	client: OpencodeClient,
	baseUrl: string,
	sessionId: string,
	schema?: Record<string, unknown>,
): Promise<T | null> {
	try {
		let latestResponse: unknown;
		for (let attempt = 1; attempt <= structuredSessionPollAttempts; attempt += 1) {
			latestResponse = await getSessionMessages(client, baseUrl, sessionId);
			const payload = extractStructuredPayloadFromSessionMessages<T>(
				latestResponse,
				schema,
			);
			if (payload !== null) {
				return payload;
			}

			const state = getLatestAssistantMessageState(latestResponse);
			if (state?.completed && state.textLength > 0) {
				return null;
			}

			if (attempt < structuredSessionPollAttempts) {
				await wait(structuredSessionPollDelayMs);
			}
		}

		return null;
	} catch (error) {
		logger.warn(
			`Could not inspect OpenCode session messages for structured payload: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

async function getSessionMessages(
	client: OpencodeClient,
	baseUrl: string,
	sessionId: string,
): Promise<unknown> {
	const sdkResponse = await withTransportRetry<
		Awaited<ReturnType<typeof client.session.messages>>
	>(
		() =>
			client.session.messages({
				path: { id: sessionId },
			} as Parameters<typeof client.session.messages>[0]),
	);

	if (getResponseData<unknown>(sdkResponse) !== undefined) {
		return sdkResponse;
	}

	return await fetchSessionMessages(baseUrl, sessionId, sdkResponse);
}

async function describeSessionStructuredState(
	client: OpencodeClient,
	baseUrl: string,
	sessionId: string,
): Promise<string> {
	try {
		const response = await getSessionMessages(client, baseUrl, sessionId);
		return describeSessionMessages(response);
	} catch (error) {
		return `could not read session messages (${error instanceof Error ? error.message : String(error)})`;
	}
}

async function fetchSessionMessages(
	baseUrl: string,
	sessionId: string,
	sdkResponse: unknown,
): Promise<unknown> {
	const url = `${baseUrl.replace(/\/$/, '')}/session/${encodeURIComponent(sessionId)}/message`;

	try {
		const response = await fetch(url);
		const text = await response.text();
		let data: unknown = text;
		if (text) {
			try {
				data = JSON.parse(text) as unknown;
			} catch {
				data = text;
			}
		}

		if (response.ok) {
			return { data };
		}

		return {
			error: {
				message: `Raw session messages request failed: ${response.status} ${response.statusText}`,
				body: data,
				sdkResponse: summarizeErrorResponse(sdkResponse),
			},
		};
	} catch (error) {
		return {
			error: {
				message: `Raw session messages request failed: ${error instanceof Error ? error.message : String(error)}`,
				sdkResponse: summarizeErrorResponse(sdkResponse),
			},
		};
	}
}

async function startIsolatedOpencodeServer(
	config: Record<string, unknown>,
	port: number,
): Promise<{ url: string; close(): Promise<void>; getRecentOutput(): string }> {
	const cwd = await mkdtemp(path.join(tmpdir(), 'code-review-agent-opencode-'));
	const proc = spawn(
		'opencode',
		['serve', `--hostname=127.0.0.1`, `--port=${port}`],
		{
			cwd,
			env: {
				...process.env,
				OPENCODE_SERVER_PASSWORD: '',
				OPENCODE_SERVER_USERNAME: '',
				OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
			},
		},
	);

	let settled = false;
	let output = '';
	const recentOutputLines: string[] = [];
	const appendRecentOutput = (chunk: string): void => {
		for (const line of chunk.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			recentOutputLines.push(trimmed);
			if (recentOutputLines.length > 50) {
				recentOutputLines.shift();
			}
		}
	};
	const url = await new Promise<string>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			proc.kill();
			reject(
				new Error(
					`Timeout waiting for OpenCode server startup on port ${port}`,
				),
			);
		}, 5000);

		proc.stdout?.on('data', chunk => {
			appendRecentOutput(chunk.toString());
			if (settled) {
				return;
			}

			output += chunk.toString();
			const lines = output.split('\n');
			for (const line of lines) {
				if (!line.startsWith('opencode server listening')) {
					continue;
				}

				const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
				if (!match) {
					settled = true;
					clearTimeout(timeoutId);
					proc.kill();
					reject(
						new Error(
							`Failed to parse OpenCode server URL from output: ${line}`,
						),
					);
					return;
				}

				settled = true;
				clearTimeout(timeoutId);
				resolve(match[1]);
				return;
			}
		});

		proc.stderr?.on('data', chunk => {
			appendRecentOutput(chunk.toString());
			output += chunk.toString();
		});

		proc.on('error', error => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeoutId);
			reject(error);
		});

		proc.on('exit', code => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeoutId);
			const details = output.trim() ? `\nServer output: ${output}` : '';
			reject(new Error(`Server exited with code ${code}${details}`));
		});
	});

	return {
		url,
		getRecentOutput(): string {
			return recentOutputLines.join('\n');
		},
		async close(): Promise<void> {
			await shutdownChildProcess(proc);
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

async function withTransportRetry<T>(operation: () => Promise<T>): Promise<T> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= transportRetryAttempts; attempt += 1) {
		const startedAt = Date.now();
		try {
			const result = await operation();
			if (attempt > 1) {
				logger.info(
					`OpenCode transport retry succeeded on attempt ${attempt}/${transportRetryAttempts} after ${Date.now() - startedAt}ms.`,
				);
			}
			return result;
		} catch (error) {
			lastError = error;
			if (
				!isRetryableTransportError(error) ||
				attempt === transportRetryAttempts
			) {
				throw error;
			}

			logger.warn(
				`OpenCode transport attempt ${attempt}/${transportRetryAttempts} failed after ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}. Retrying in ${transportRetryBaseDelayMs * attempt}ms.`,
			);

			await wait(transportRetryBaseDelayMs * attempt);
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function shutdownChildProcess(
	proc: ReturnType<typeof spawn>,
): Promise<void> {
	if (proc.exitCode !== null || proc.killed) {
		return;
	}

	const exited = waitForProcessExit(proc);
	proc.kill('SIGTERM');

	const terminated = await Promise.race([
		exited.then(() => true),
		wait(3000).then(() => false),
	]);

	if (terminated) {
		return;
	}

	proc.kill('SIGKILL');
	await Promise.race([exited, wait(2000)]);
}

function waitForProcessExit(proc: ReturnType<typeof spawn>): Promise<void> {
	return new Promise(resolve => {
		proc.once('exit', () => resolve());
		proc.once('error', () => resolve());
	});
}

function wait(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

async function getAvailablePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();

		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() =>
					reject(
						new Error('Could not determine an available OpenCode server port.'),
					),
				);
				return;
			}

			const { port } = address;
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}

				resolve(port);
			});
		});
	});
}

function sanitizeOpencodeServerConfig(
	config: Record<string, unknown>,
): Record<string, unknown> {
	const {
		review: _review,
		__configDir,
		...serverConfig
	} = config as Record<string, unknown> & { __configDir?: string };
	return resolveFileReferences(
		serverConfig,
		typeof __configDir === 'string' ? __configDir : process.cwd(),
	) as Record<string, unknown>;
}

function resolveFileReferences(value: unknown, configDir: string): unknown {
	if (typeof value === 'string') {
		const match = value.match(/^\{file:(.+)\}$/);
		if (!match) {
			return value;
		}

		const filePath = match[1]?.trim();
		if (!filePath) {
			return value;
		}

		if (path.isAbsolute(filePath) || filePath.startsWith('~')) {
			return value;
		}

		return `{file:${path.resolve(configDir, filePath)}}`;
	}

	if (Array.isArray(value)) {
		return value.map(item => resolveFileReferences(item, configDir));
	}

	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, nestedValue]) => [
				key,
				resolveFileReferences(nestedValue, configDir),
			]),
		);
	}

	return value;
}

function getResponseData<T>(response: unknown): T | undefined {
	if (!response || typeof response !== 'object') {
		return undefined;
	}

	const candidate = response as { data?: T; error?: unknown };
	if (candidate.error) {
		return undefined;
	}

	if (candidate.data !== undefined) {
		return candidate.data;
	}

	return response as T;
}

function isRetryableTransportError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes('fetch failed') ||
		message.includes('ECONNRESET') ||
		message.includes('socket hang up')
	);
}

function buildOpencodeErrorMessage(
	action: string,
	response: unknown,
	fallback: string,
): string {
	if (!response || typeof response !== 'object') {
		return fallback;
	}

	const candidate = response as {
		error?: unknown;
		response?: { status?: number; statusText?: string };
	};

	if (!candidate.error) {
		return fallback;
	}

	const errorText =
		typeof candidate.error === 'string'
			? candidate.error
			: JSON.stringify(candidate.error);
	const status = candidate.response?.status;
	const statusText = candidate.response?.statusText;
	const details = [status, statusText].filter(Boolean).join(' ');

	return details
		? `OpenCode failed to ${action}: ${errorText} (${details})`
		: `OpenCode failed to ${action}: ${errorText}`;
}

function getStructuredOutputInfo(
	response: unknown,
):
	| { structured_output?: unknown; error?: { name?: string; message?: string } }
	| undefined {
	if (!response || typeof response !== 'object') {
		return undefined;
	}

	const candidate = response as {
		data?: {
			info?: {
				structured_output?: unknown;
				structured?: unknown;
				error?: {
					name?: string;
					message?: string;
					data?: { message?: string };
				};
			};
		};
		info?: {
			structured_output?: unknown;
			structured?: unknown;
			error?: { name?: string; message?: string; data?: { message?: string } };
		};
	};

	const info = candidate.data?.info ?? candidate.info;
	if (!info) {
		return undefined;
	}

	return {
		structured_output: info.structured_output ?? info.structured,
		error: info.error
			? {
					name: info.error.name,
					message: info.error.message ?? info.error.data?.message,
				}
			: undefined,
	};
}

function extractStructuredPayloadFromText<T>(response: unknown): T | null {
	const text = extractPromptText(response);
	if (!text) {
		return null;
	}

	return parseStructuredPayloadFromText<T>(text);
}

function extractNoIssuesPayloadFromText<T>(
	response: unknown,
	schema: Record<string, unknown>,
): T | null {
	const text = extractPromptText(response);
	return parseNoIssuesPayloadFromText<T>(text, schema);
}

function extractStructuredPayloadFromSessionMessages<T>(
	response: unknown,
	schema?: Record<string, unknown>,
): T | null {
	const messages = getSessionMessageEntries(response);

	if (!messages) {
		return null;
	}

	for (const message of [...messages].reverse()) {
		if (message.info?.role && message.info.role !== 'assistant') {
			continue;
		}

		const structured =
			message.info?.structured_output ?? message.info?.structured;
		if (structured !== undefined) {
			return structured as T;
		}

		const text = extractTextFromParts(message.parts ?? []);
		const payload = parseStructuredPayloadFromText<T>(text);
		if (payload !== null) {
			return payload;
		}

		if (schema) {
			const noIssuesPayload = parseNoIssuesPayloadFromText<T>(text, schema);
			if (noIssuesPayload !== null) {
				return noIssuesPayload;
			}
		}
	}

	return null;
}

function describeSessionMessages(response: unknown): string {
	const messages = getSessionMessageEntries(response);
	if (!messages) {
		const error = describeErrorPayload(response);
		if (error) {
			return error;
		}

		return `messages payload unavailable; response keys: ${describeObjectKeys(response)}`;
	}

	const latestAssistant = getLatestAssistantMessageStateFromEntries(messages);
	if (!latestAssistant) {
		return `messages=${messages.length}; assistant messages=0`;
	}

	return [
		`messages=${messages.length}`,
		`assistant completed=${latestAssistant.completed}`,
		latestAssistant.finish ? `finish=${latestAssistant.finish}` : null,
		latestAssistant.errorName ? `error=${latestAssistant.errorName}` : null,
		`structured=${latestAssistant.hasStructured}`,
		`textLength=${latestAssistant.textLength}`,
		latestAssistant.textPreview
			? `text="${truncateText(latestAssistant.textPreview, 300)}"`
			: null,
	]
		.filter((value): value is string => Boolean(value))
		.join(', ');
}

function getLatestAssistantMessageState(response: unknown):
	| {
			completed: boolean;
			finish?: string;
			errorName?: string;
			hasStructured: boolean;
			textLength: number;
			textPreview: string;
	  }
	| null {
	const messages = getSessionMessageEntries(response);
	return messages ? getLatestAssistantMessageStateFromEntries(messages) : null;
}

function getLatestAssistantMessageStateFromEntries(
	messages: SessionMessageEntry[],
): {
	completed: boolean;
	finish?: string;
	errorName?: string;
	hasStructured: boolean;
	textLength: number;
	textPreview: string;
} | null {
	for (const message of [...messages].reverse()) {
		if (message.info?.role && message.info.role !== 'assistant') {
			continue;
		}

		const text = extractTextFromParts(message.parts ?? []);
		return {
			completed: Boolean(message.info?.time?.completed),
			finish: message.info?.finish,
			errorName: message.info?.error?.name,
			hasStructured:
				message.info?.structured_output !== undefined ||
				message.info?.structured !== undefined,
			textLength: text.length,
			textPreview: text,
		};
	}

	return null;
}

type SessionMessageEntry = {
	info?: {
		role?: string;
		structured?: unknown;
		structured_output?: unknown;
		finish?: string;
		error?: { name?: string };
		time?: { completed?: number };
	};
	parts?: Array<{ type: string; text?: string }>;
};

function getSessionMessageEntries(response: unknown): SessionMessageEntry[] | null {
	const messages = getResponseData<SessionMessageEntry[]>(response);
	return Array.isArray(messages) ? messages : null;
}

function describeObjectKeys(value: unknown): string {
	if (!value || typeof value !== 'object') {
		return typeof value;
	}

	return Object.keys(value as Record<string, unknown>).join(', ') || 'none';
}

function describeErrorPayload(value: unknown): string | null {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const error = (value as { error?: unknown }).error;
	if (!error) {
		return null;
	}

	if (typeof error === 'string') {
		return `messages request error: ${truncateText(error, 500)}`;
	}

	if (typeof error !== 'object') {
		return `messages request error: ${String(error)}`;
	}

	const candidate = error as {
		message?: string;
		body?: unknown;
		sdkResponse?: unknown;
	};
	const details = [
		candidate.message,
		candidate.body === undefined
			? null
			: `body=${truncateText(formatDiagnosticValue(candidate.body), 500)}`,
		candidate.sdkResponse === undefined
			? null
			: `sdk=${truncateText(formatDiagnosticValue(candidate.sdkResponse), 500)}`,
	]
		.filter((part): part is string => Boolean(part))
		.join('; ');

	return details ? `messages request error: ${details}` : null;
}

function formatDiagnosticValue(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

function summarizeErrorResponse(response: unknown): unknown {
	if (!response || typeof response !== 'object') {
		return response;
	}

	const candidate = response as {
		error?: unknown;
		response?: { status?: number; statusText?: string };
	};

	return {
		keys: describeObjectKeys(response),
		status: candidate.response?.status,
		statusText: candidate.response?.statusText,
		error:
			typeof candidate.error === 'string'
				? candidate.error
				: candidate.error
					? JSON.stringify(candidate.error).slice(0, 1000)
					: undefined,
	};
}

function parseNoIssuesPayloadFromText<T>(
	text: string,
	schema: Record<string, unknown>,
): T | null {
	if (!isReviewIssuesEnvelopeSchema(schema)) {
		return null;
	}

	const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
	if (!normalized) {
		return null;
	}

	const noIssuesPatterns = [
		/\bno\s+(issues|findings|problems|bugs)\b/,
		/\bdid(?:\s+not|n't)\s+find\s+any\s+(issues|findings|problems|bugs)\b/,
		/\bnothing\s+to\s+(report|flag)\b/,
	];

	return noIssuesPatterns.some(pattern => pattern.test(normalized))
		? ({ issues: [] } as T)
		: null;
}

function isReviewIssuesEnvelopeSchema(
	schema: Record<string, unknown>,
): boolean {
	const properties = schema.properties;
	if (!properties || typeof properties !== 'object') {
		return false;
	}

	const issues = (properties as Record<string, unknown>).issues;
	return Boolean(
		issues &&
		typeof issues === 'object' &&
		(issues as Record<string, unknown>).type === 'array',
	);
}

function parseStructuredPayloadFromText<T>(text: string): T | null {
	const candidatePayloads = [
		extractTaggedPayload(text),
		extractFencedJson(text),
		extractJsonObject(text),
		extractJsonArray(text),
	].filter((value): value is string => Boolean(value));

	for (const candidate of candidatePayloads) {
		try {
			return JSON.parse(candidate) as T;
		} catch {
			continue;
		}
	}

	return null;
}

function extractPromptText(response: unknown): string {
	if (!response || typeof response !== 'object') {
		return '';
	}

	const data = getResponseData<{
		parts?: Array<{ type: string; text?: string }>;
	}>(response);
	if (!data?.parts) {
		return '';
	}

	return extractTextFromParts(data.parts);
}

function truncateText(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, ' ').trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}

	return `${normalized.slice(0, maxLength - 3)}...`;
}

function buildStructuredJsonRetryPrompt(
	prompt: string,
	schema: Record<string, unknown>,
): string {
	return [
		prompt,
		'',
		'Your previous response did not produce a structured payload.',
		'Return only valid JSON wrapped between BEGIN_JSON and END_JSON.',
		'Do not include any prose outside the markers.',
		'If there are no findings or no items, return a schema-shaped object with empty arrays instead of prose.',
		'Required JSON schema:',
		JSON.stringify(schema, null, 2),
		'',
		'BEGIN_JSON',
		'{',
		'  "...": "follow the schema above"',
		'}',
		'END_JSON',
	].join('\n');
}

function extractTaggedPayload(text: string): string | null {
	const start = text.indexOf('BEGIN_JSON');
	const end = text.lastIndexOf('END_JSON');

	if (start === -1 || end === -1 || end <= start) {
		return null;
	}

	return text.slice(start + 'BEGIN_JSON'.length, end).trim();
}

function extractFencedJson(text: string): string | null {
	const fencedJsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
	if (fencedJsonMatch?.[1]) {
		return fencedJsonMatch[1].trim();
	}

	const fencedMatch = text.match(/```\s*([\s\S]*?)\s*```/i);
	return fencedMatch?.[1]?.trim() ?? null;
}

function extractJsonObject(text: string): string | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end === -1 || end < start) {
		return null;
	}

	return text.slice(start, end + 1);
}

function extractJsonArray(text: string): string | null {
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	if (start === -1 || end === -1 || end < start) {
		return null;
	}

	return text.slice(start, end + 1);
}

function extractTextFromParts(
	parts: Array<{ type: string; text?: string }>,
): string {
	return parts
		.filter(part => part.type === 'text' && typeof part.text === 'string')
		.map(part => part.text)
		.join('\n')
		.trim();
}

export type { OpencodeClient };

export const __test__ = {
	buildStructuredJsonRetryPrompt,
	isRetryableTransportError,
	getStructuredOutputInfo,
	extractStructuredPayloadFromText,
	extractStructuredPayloadFromSession,
	extractStructuredPayloadFromSessionMessages,
	extractNoIssuesPayloadFromText,
	describeSessionMessages,
	extractPromptText,
};
