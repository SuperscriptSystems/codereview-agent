import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import { logger } from '../core/logger.js';
import { defaultPromptTimeoutMs, runAsyncPrompt } from './async-prompt.js';
import {
	formatRecentServerOutput,
	formatTransportError,
	isRetryableTransportError,
	runRequest,
	waitForDelay,
	withTransportRetry,
} from './request.js';

const structuredSessionPollAttempts = 12;
const structuredSessionPollDelayMs = 500;
const serverStartupTimeoutMs = 60_000;
const serverStartupPollDelayMs = 100;
const repositoryReadyTimeoutMs = 60_000;

export interface OpencodeSessionClient {
	createSession(title: string, signal?: AbortSignal): Promise<string>;
	listAgents(): Promise<string[]>;
	promptText(
		sessionId: string,
		options: {
			agent: string;
			system?: string;
			prompt: string;
			signal?: AbortSignal;
		},
	): Promise<string>;
	promptStructured<T>(
		sessionId: string,
		options: {
			agent: string;
			system?: string;
			prompt: string;
			schema: Record<string, unknown>;
			retryCount?: number;
			signal?: AbortSignal;
		},
	): Promise<T>;
	abortSession(sessionId: string, signal?: AbortSignal): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	getDiagnostics(): { recentServerOutput: string; serverUrl?: string; serverVersion?: string };
	close(): Promise<void>;
}

export async function createSessionClient(
	config: Record<string, unknown>,
	directory?: string,
): Promise<OpencodeSessionClient> {
	const startup = new AbortController();
	const startupTimer = setTimeout(() => startup.abort(
		new Error(`OpenCode server startup timed out after ${serverStartupTimeoutMs}ms.`),
	), serverStartupTimeoutMs);
	let startedServer: Awaited<ReturnType<typeof startIsolatedOpencodeServer>> | undefined;
	const lifetime = new AbortController();
	let client: OpencodeClient;
	try {
		const port = await getAvailablePort();
		startedServer = await startIsolatedOpencodeServer(
			sanitizeOpencodeServerConfig(config), port, startup.signal,
		);
		client = createOpencodeClient({ baseUrl: startedServer.url, directory });
		await waitForRepositoryReady(
			client,
			startedServer.url,
			startup.signal,
			startedServer.getRecentOutput,
			directory,
		);
	} catch (error) {
		lifetime.abort(error);
		if (startedServer) {
			logger.warn(`OpenCode startup recent server output:\n${startedServer.getRecentOutput()}`);
			await startedServer.close();
		}
		throw error;
	} finally {
		clearTimeout(startupTimer);
	}
	const server = startedServer;
	const baseUrl = server.url;
	const requestSignal = (signal?: AbortSignal) =>
		signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;

	return {
		async createSession(title: string, signal?: AbortSignal): Promise<string> {
			const response = await runRequest(
				requestSignal =>
					client.session.create({ body: { title }, signal: requestSignal }),
				{
					label: 'OpenCode createSession',
					getRecentServerOutput: server.getRecentOutput,
					signal: requestSignal(signal),
					retry: false,
				},
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
			const response = await runRequest(
				signal => client.app.agents({ signal }),
				{
					label: 'OpenCode listAgents',
					getRecentServerOutput: server.getRecentOutput,
					signal: lifetime.signal,
				},
			);
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
			options: {
				agent: string;
				system?: string;
				prompt: string;
				signal?: AbortSignal;
			},
		): Promise<string> {
			const response = await runAsyncPrompt(
				client,
				sessionId,
				{
					agent: options.agent,
					system: options.system,
					parts: [{ type: 'text', text: options.prompt }],
				},
				{
					signal: requestSignal(
						options.signal ?? AbortSignal.timeout(defaultPromptTimeoutMs),
					),
					cleanupSignal: lifetime.signal,
					label: 'OpenCode text prompt',
					getRecentServerOutput: server.getRecentOutput,
				},
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
				signal?: AbortSignal;
			},
		): Promise<T> {
			const signal = requestSignal(
				options.signal ?? AbortSignal.timeout(defaultPromptTimeoutMs),
			);
			const response = await runAsyncPrompt(
				client,
				sessionId,
				{
					agent: options.agent,
					system: options.system,
					parts: [{ type: 'text', text: options.prompt }],
					format: {
						type: 'json_schema',
						retryCount: options.retryCount ?? 3,
						schema: options.schema,
					},
				},
				{
					signal,
					cleanupSignal: lifetime.signal,
					label: 'OpenCode structured prompt',
					getRecentServerOutput: server.getRecentOutput,
				},
			);

			return await extractStructuredPromptPayload<T>(
				client,
				baseUrl,
				sessionId,
				{
					...options,
					signal,
					cleanupSignal: lifetime.signal,
					getRecentServerOutput: server.getRecentOutput,
				},
				response,
			);
		},
		async close(): Promise<void> {
			lifetime.abort(new Error('OpenCode client closed.'));
			await server.close();
		},
		async abortSession(sessionId: string, signal?: AbortSignal): Promise<void> {
			await runRequest(
				requestSignal =>
					client.session.abort({
						path: { id: sessionId },
						signal: requestSignal,
					}),
				{
					signal: requestSignal(signal),
					timeoutMs: 5000,
					label: 'OpenCode abortSession',
					quiet: true,
				},
			);
		},
		async deleteSession(sessionId: string): Promise<void> {
			await runRequest(
				signal =>
					client.session.delete({
						path: { id: sessionId },
						signal,
					}),
				{
					signal: lifetime.signal,
					timeoutMs: 5000,
					label: 'OpenCode deleteSession',
					quiet: true,
				},
			);
		},
		getDiagnostics() {
			return { recentServerOutput: server.getRecentOutput(), serverUrl: server.url, serverVersion: server.version };
		},
	};
}

async function extractStructuredPromptPayload<T>(
	client: OpencodeClient,
	baseUrl: string,
	sessionId: string,
	options: Parameters<OpencodeSessionClient['promptStructured']>[1] & {
		cleanupSignal?: AbortSignal;
		getRecentServerOutput?: () => string;
	},
	response: unknown,
): Promise<T> {
	const responseError = getResponseErrorMessage(response);
	if (responseError) {
		throw new Error(
			buildOpencodeErrorMessage(
				'run a structured prompt',
				response,
				responseError,
			),
		);
	}
	const info = getStructuredOutputInfo(response);
	if (info?.error) {
		throw new Error(
			info.error.message ?? 'OpenCode structured output validation failed.',
		);
	}
	// A native structured response needs no extra model turn to reformat it.
	if (info?.structured_output !== undefined) {
		return info.structured_output as T;
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

	const plainTextFallback = await promptStructuredViaTextFallback<T>(
		client,
		baseUrl,
		sessionId,
		options,
	);
	if (plainTextFallback !== null) {
		return plainTextFallback;
	}

	const promptText = extractPromptText(response);
	const sessionDetails = describeSessionMessages({
		data: [getResponseData(response)],
	});
	const details = promptText
		? ` Raw response text: ${truncateText(promptText, 400)}`
		: '';
	throw new Error(
		`OpenCode did not return a structured output payload.${details}${sessionDetails ? ` Session state: ${sessionDetails}` : ''}`,
	);
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
		signal?: AbortSignal;
		cleanupSignal?: AbortSignal;
		getRecentServerOutput?: () => string;
	},
): Promise<T | null> {
	const startedAt = Date.now();
	logger.info(
		'Structured output missing, retrying with plain-text JSON fallback.',
	);
	const response = await runAsyncPrompt(
		client,
		sessionId,
		{
			agent: options.agent,
			system: options.system,
			parts: [
				{
					type: 'text',
					text: buildStructuredJsonRetryPrompt(options.prompt, options.schema),
				},
			],
		},
		{
			signal: options.signal,
			cleanupSignal: options.cleanupSignal,
			getRecentServerOutput: options.getRecentServerOutput,
			label: 'OpenCode JSON fallback',
		},
	);
	logger.info(
		`Plain-text structured fallback completed in ${Date.now() - startedAt}ms.`,
	);

	const fallbackError = getResponseErrorMessage(response);
	if (fallbackError) {
		logger.warn(
			`Plain-text structured fallback returned an OpenCode error: ${truncateText(fallbackError, 500)}`,
		);
		return null;
	}

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

	return null;
}

async function extractStructuredPayloadFromSession<T>(
	client: OpencodeClient,
	baseUrl: string,
	sessionId: string,
	schema?: Record<string, unknown>,
): Promise<T | null> {
	try {
		let latestResponse: unknown;
		for (
			let attempt = 1;
			attempt <= structuredSessionPollAttempts;
			attempt += 1
		) {
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
	const sdkResponse = await runRequest<
		Awaited<ReturnType<typeof client.session.messages>>
	>(
		signal =>
			client.session.messages({
				path: { id: sessionId },
				signal,
			} as Parameters<typeof client.session.messages>[0]),
		{ label: 'OpenCode diagnostic session messages', quiet: true },
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
		const response = await runRequest(signal => fetch(url, { signal }), {
			label: 'OpenCode raw session messages',
			quiet: true,
		});
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
	signal: AbortSignal,
): Promise<{ url: string; version: string; close(): Promise<void>; getRecentOutput(): string }> {
	const cwd = await mkdtemp(path.join(tmpdir(), 'code-review-agent-opencode-'));
	const proc = spawn(
		'opencode',
		[
			'serve',
			'--pure',
			'--print-logs',
			'--log-level=DEBUG',
			`--hostname=127.0.0.1`,
			`--port=${port}`,
		],
		{
			cwd,
			env: buildOpencodeServerEnv(process.env, config, cwd),
		},
	);

	let output = '';
	proc.stdout?.on('data', chunk => {
		const text = chunk.toString();
		output = (output + text).slice(-64_000);
	});

	proc.stderr?.on('data', chunk => {
		const text = chunk.toString();
		output = (output + text).slice(-64_000);
	});

	const url = `http://127.0.0.1:${port}`;
	let health: { healthy: true; version: string };
	try {
		await waitForServerListening(proc, port, () => output, signal);
		health = await waitForHttpReady(url, signal, () => output);
		logger.info(`OpenCode server version: ${health.version}.`);
	} catch (error) {
		if (output) logger.warn(`OpenCode startup server output:\n${formatRecentServerOutput(output)}`);
		await shutdownChildProcess(proc);
		await rm(cwd, { recursive: true, force: true });
		throw error;
	}

	return {
		url,
		version: health.version,
		getRecentOutput(): string {
			return formatRecentServerOutput(output);
		},
		async close(): Promise<void> {
			await shutdownChildProcess(proc);
			await rm(cwd, { recursive: true, force: true });
		},
	};
}

async function waitForRepositoryReady(
	client: OpencodeClient,
	baseUrl: string,
	signal: AbortSignal,
	getRecentServerOutput: () => string,
	expectedDirectory?: string,
): Promise<void> {
	const data = await runRequest(
		async requestSignal => {
			const response = await client.path.get({ signal: requestSignal });
			const data = getResponseData<{ directory?: string }>(response);
			if (typeof data?.directory !== 'string') {
				throw new Error(
					buildOpencodeErrorMessage(
						'initialize repository',
						response,
						'OpenCode did not return a repository path.',
					),
				);
			}
			if (
				expectedDirectory &&
				path.resolve(data.directory) !== path.resolve(expectedDirectory)
			) {
				throw new Error(
					`OpenCode initialized ${data.directory} instead of the requested repository ${expectedDirectory}.`,
				);
			}
			return data;
		},
		{
			signal,
			label: 'OpenCode repository initialization',
			timeoutMs: repositoryReadyTimeoutMs,
			retry: false,
			getRecentServerOutput,
		},
	);
	logger.info(`OpenCode repository ready: ${data.directory}.`);
}

async function waitForHttpReady(
	baseUrl: string,
	signal: AbortSignal,
	getRecentServerOutput: () => string,
): Promise<{ healthy: true; version: string }> {
	return await runRequest(async startupSignal => {
		let attempt = 0;
		while (true) {
			startupSignal.throwIfAborted();
			attempt += 1;
			try {
				return await runRequest(async requestSignal => {
					const response = await fetch(`${baseUrl}/global/health`, { signal: requestSignal });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const health = await response.json() as { healthy?: boolean; version?: string };
					if (!health.healthy || typeof health.version !== 'string') {
						throw new Error('OpenCode returned an invalid health response.');
					}
					return { healthy: true as const, version: health.version };
				}, { signal: startupSignal, label: 'OpenCode health probe', timeoutMs: 5000, retry: false, quiet: true });
			} catch (error) {
				startupSignal.throwIfAborted();
				logger.info(`OpenCode API is not ready (probe ${attempt}: ${formatTransportError(error)}); retrying within the startup deadline.`);
				await waitForDelay(250, startupSignal);
			}
		}
	}, { signal, label: 'OpenCode API health', timeoutMs: serverStartupTimeoutMs, retry: false, getRecentServerOutput });
}

function buildOpencodeServerEnv(
	baseEnv: NodeJS.ProcessEnv,
	config: Record<string, unknown>,
	isolatedDirectory: string,
): NodeJS.ProcessEnv {
	return {
		...baseEnv,
		XDG_CONFIG_HOME: path.join(isolatedDirectory, 'config'),
		XDG_DATA_HOME: path.join(isolatedDirectory, 'data'),
		XDG_STATE_HOME: path.join(isolatedDirectory, 'state'),
		OPENCODE_TEST_HOME: path.join(isolatedDirectory, 'home'),
		OPENCODE_CONFIG: undefined,
		OPENCODE_CONFIG_DIR: path.join(isolatedDirectory, 'config', 'opencode'),
		OPENCODE_PERMISSION: undefined,
		OPENCODE_DISABLE_PROJECT_CONFIG: '1',
		OPENCODE_SERVER_PASSWORD: '',
		OPENCODE_SERVER_USERNAME: '',
		OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
	};
}

async function waitForServerListening(
	proc: ReturnType<typeof spawn>,
	port: number,
	getOutput: () => string,
	signal: AbortSignal,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let pollTimer: NodeJS.Timeout | undefined;
		const onError = (error: Error) => finish(error);
		const onExit = (code: number | null) => finish(new Error(`OpenCode server exited with code ${code}${formatServerOutput(getOutput())}`));
		const onAbort = () => finish(signal.reason);
		const finish = (error?: Error): void => {
			if (settled) {
				return;
			}

			settled = true;
			if (pollTimer) {
				clearTimeout(pollTimer);
			}
			proc.off('error', onError);
			proc.off('exit', onExit);
			signal.removeEventListener('abort', onAbort);

			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		const poll = (): void => {
			if (settled) {
				return;
			}

			if (getOutput().includes(`opencode server listening on http://127.0.0.1:${port}`)) {
				finish();
				return;
			}

			pollTimer = setTimeout(poll, serverStartupPollDelayMs);
		};

		proc.once('error', onError);
		proc.once('exit', onExit);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
		else poll();
	});
}

function formatServerOutput(output: string): string {
	const trimmed = formatRecentServerOutput(output);
	return trimmed ? `\nServer output:\n${trimmed}` : '';
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

function getResponseErrorMessage(response: unknown): string | null {
	if (!response || typeof response !== 'object') {
		return null;
	}

	const error = (response as { error?: unknown }).error;
	if (!error) {
		return null;
	}

	if (typeof error === 'string') {
		return error;
	}

	if (typeof error !== 'object') {
		return String(error);
	}

	const candidate = error as {
		message?: string;
		name?: string;
		data?: { message?: string };
	};
	return candidate.message ?? candidate.data?.message ?? JSON.stringify(error);
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

function getLatestAssistantMessageState(response: unknown): {
	completed: boolean;
	finish?: string;
	errorName?: string;
	hasStructured: boolean;
	textLength: number;
	textPreview: string;
} | null {
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

function getSessionMessageEntries(
	response: unknown,
): SessionMessageEntry[] | null {
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
	waitForHttpReady,
	waitForRepositoryReady,
	extractStructuredPromptPayload,
	formatRecentServerOutput,
	formatTransportError,
	withTransportRetry,
	buildStructuredJsonRetryPrompt,
	isRetryableTransportError,
	getResponseErrorMessage,
	getStructuredOutputInfo,
	extractStructuredPayloadFromText,
	extractStructuredPayloadFromSession,
	extractStructuredPayloadFromSessionMessages,
	extractNoIssuesPayloadFromText,
	describeSessionMessages,
	extractPromptText,
	buildOpencodeServerEnv,
};
