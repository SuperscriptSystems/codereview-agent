import assert from 'node:assert/strict';
import {
	access,
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

import { createOpencodeClient } from '@opencode-ai/sdk';
import { loadRawConfig } from '../config/load-config.js';
import { reviewIssuesEnvelopeJsonSchema } from '../core/models.js';
import { createSessionClient, type OpencodeSessionClient } from './client.js';
import { runAsyncPrompt } from './async-prompt.js';
import { reviewIssuesEnvelopeSchema } from '../core/models.js';
import { nativeReviewTools } from './native-file-guard.js';

// This runs against the installed binary, not a mock server, and never calls an LLM.
async function checkServer(): Promise<void> {
	const fixture = await realpath(
		await mkdtemp(path.join(tmpdir(), 'code-review-agent-server-check-')),
	);
	const previousEnv = { ...process.env };
	let client: OpencodeSessionClient | undefined;
	let modelRequests = 0;
	let mockGeneration = false;
	let filteredToolsVerified = false;
	let contextLeak = false;
	let applicationContextSeen = false;
	const findings = {
		issues: [
			{
				filePath: 'src/example.ts',
				lineNumber: 1,
				issueType: 'Security',
				comment: 'Synthetic tenant-isolation finding for the protocol check.',
			},
		],
	};
	const gateway = createServer(async (request, response) => {
		modelRequests += 1;
		if (!mockGeneration) {
			response.writeHead(503, { 'Content-Type': 'application/json' });
			response.end('{"error":"The noReply check must not invoke generation."}');
			return;
		}
		let text = '';
		for await (const chunk of request) text += chunk;
		const input = JSON.parse(text);
		contextLeak ||= text.includes('TEST_SECRET');
		applicationContextSeen ||= text.includes('APPLICATION_CONTEXT_MARKER');
		const toolNames =
			input.tools?.map(
				(entry: { name?: string; function?: { name?: string } }) =>
					entry.name ?? entry.function?.name,
			) ?? [];
		filteredToolsVerified =
			['glob', 'read', 'grep', 'StructuredOutput'].every(name =>
				toolNames.includes(name),
			) &&
			toolNames.every(
				(name: string) =>
					nativeReviewTools[name as keyof typeof nativeReviewTools] === true,
			);
		if (!filteredToolsVerified) {
			console.error('Filtered context tool allowlist mismatch:', toolNames);
			response.writeHead(500, { 'Content-Type': 'application/json' });
			response.end(
				JSON.stringify({
					error: 'Filtered context tool allowlist mismatch',
					toolNames,
				}),
			);
			return;
		}
		const tool = input.tools?.find(
			(entry: { name?: string; function?: { name?: string } }) =>
				entry.name === 'StructuredOutput' ||
				entry.function?.name === 'StructuredOutput',
		);
		if (!tool) {
			response.writeHead(500, { 'Content-Type': 'application/json' });
			response.end('{"error":"Native StructuredOutput tool is missing."}');
			return;
		}
		response.writeHead(200, { 'Content-Type': 'text/event-stream' });
		const checks = [
			{ name: 'glob', args: { pattern: '**/*', path: fixture } },
			{ name: 'grep', args: { pattern: 'CONTEXT_MARKER', path: fixture } },
			{
				name: 'read',
				args: { filePath: path.join(fixture, 'src/example.test.ts') },
			},
			{
				name: 'read',
				args: { filePath: path.join(fixture, 'src/example.ts') },
			},
		];
		const check = checks[modelRequests - 1];
		const toolName = check?.name ?? 'StructuredOutput';
		const args = JSON.stringify(check?.args ?? findings);
		const callId = `call_check_${modelRequests}`;
		if (request.url?.endsWith('/chat/completions')) {
			const chunk = {
				id: 'chatcmpl-check',
				object: 'chat.completion.chunk',
				created: 1,
				model: input.model,
				choices: [
					{
						index: 0,
						delta: {
							role: 'assistant',
							tool_calls: [
								{
									index: 0,
									id: callId,
									type: 'function',
									function: { name: toolName, arguments: args },
								},
							],
						},
						finish_reason: null,
					},
				],
			};
			response.write(`data: ${JSON.stringify(chunk)}\n\n`);
			response.write(
				`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
			);
		} else {
			const item = {
				type: 'function_call',
				id: `fc_check_${modelRequests}`,
				call_id: callId,
				name: toolName,
				arguments: args,
				status: 'completed',
			};
			const emit = (type: string, data: Record<string, unknown>) =>
				response.write(
					`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
				);
			emit('response.created', {
				response: {
					id: 'resp_check',
					model: input.model,
					created_at: 1,
					status: 'in_progress',
					output: [],
				},
			});
			emit('response.output_item.added', {
				output_index: 0,
				item: { ...item, arguments: '', status: 'in_progress' },
			});
			emit('response.function_call_arguments.delta', {
				item_id: item.id,
				output_index: 0,
				delta: args,
			});
			emit('response.function_call_arguments.done', {
				item_id: item.id,
				output_index: 0,
				arguments: args,
			});
			emit('response.output_item.done', { output_index: 0, item });
			emit('response.completed', {
				response: {
					id: 'resp_check',
					model: input.model,
					created_at: 1,
					status: 'completed',
					output: [item],
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					},
				},
			});
		}
		response.end();
	});
	try {
		await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
		const address = gateway.address() as { port: number };
		const gatewayUrl = `http://127.0.0.1:${address.port}/v1`;
		const globalConfigDir = path.join(fixture, 'global', 'opencode');
		await mkdir(globalConfigDir, { recursive: true });
		const decoy = JSON.stringify({
			model: 'decoy/model',
			agent: { reviewer: { prompt: 'Decoy system prompt' } },
		});
		await writeFile(path.join(globalConfigDir, 'opencode.json'), decoy);
		await writeFile(path.join(fixture, 'opencode.json'), decoy);
		await mkdir(path.join(fixture, '.opencode', 'plugins'), {
			recursive: true,
		});
		const decoyPluginMarker = path.join(fixture, 'decoy-plugin-loaded');
		await writeFile(
			path.join(fixture, '.opencode', 'plugins', 'decoy.js'),
			`import { writeFile } from 'node:fs/promises'; export default async () => { await writeFile(${JSON.stringify(decoyPluginMarker)}, 'loaded'); return {}; };`,
		);
		const decoyHome = path.join(fixture, 'decoy-home');
		await mkdir(path.join(decoyHome, '.opencode'), { recursive: true });
		await writeFile(path.join(decoyHome, '.opencode', 'opencode.json'), decoy);
		process.env.XDG_CONFIG_HOME = path.dirname(globalConfigDir);
		process.env.OPENCODE_TEST_HOME = decoyHome;
		process.env.OPENCODE_CONFIG = path.join(globalConfigDir, 'opencode.json');
		process.env.OPENAI_API_KEY = 'startup-check-unused-key';
		process.env.OPENCODE_DISABLE_MODELS_FETCH = '1';
		const rawConfig = await loadRawConfig(fixture);
		await mkdir(path.join(fixture, 'src'));
		await writeFile(
			path.join(fixture, 'src/example.ts'),
			'export const APPLICATION_CONTEXT_MARKER = true;',
		);
		await writeFile(
			path.join(fixture, 'src/example.test.ts'),
			'TEST_SECRET CONTEXT_MARKER',
		);
		await execa('git', ['init'], { cwd: fixture });
		await execa('git', ['add', 'src'], { cwd: fixture });
		// A loopback trap makes an unexpected generation fail instead of spending tokens.
		const provider = rawConfig.provider as Record<
			string,
			{ options: Record<string, unknown> }
		>;
		provider.openai.options.baseURL = gatewayUrl;
		client = await createSessionClient(rawConfig, fixture, {
			testKeywords: [],
			filtering: {
				ignoredExtensions: [],
				ignoredPaths: [],
				ignoredPatterns: [],
			},
		});
		const diagnostics = client.getDiagnostics();
		assert.equal(
			await access(decoyPluginMarker).then(
				() => true,
				() => false,
			),
			false,
			'Repository-local plugins must not load alongside the trusted guard.',
		);
		const manifest = JSON.parse(
			await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
		);
		const expectedVersion = manifest.dependencies['@opencode-ai/sdk'];
		assert.equal(
			diagnostics.serverVersion,
			expectedVersion,
			'The installed OpenCode must match the pinned SDK version.',
		);
		assert.ok(diagnostics.serverUrl);
		const sdk = createOpencodeClient({
			baseUrl: diagnostics.serverUrl,
			directory: fixture,
		});
		const config = (
			await sdk.config.get({
				signal: AbortSignal.timeout(15_000),
				throwOnError: true,
			})
		).data;
		assert.equal(
			config.model,
			rawConfig.model,
			'reviewer-opencode.json model was not applied.',
		);
		assert.equal(config.provider?.openai?.options?.baseURL, gatewayUrl);
		for (const name of ['reviewer', 'general']) {
			const agent = config.agent?.[name];
			assert.ok(agent, `Missing configured ${name} agent.`);
			assert.equal(
				agent.prompt,
				undefined,
				`${name} must use the native system prompt.`,
			);
			assert.equal(
				typeof agent.permission === 'object'
					? agent.permission.edit
					: undefined,
				'deny',
			);
		}
		const sessionId = await client.createSession('server-startup-check');
		const instructionText =
			'<BEGIN_REPOSITORY_INSTRUCTIONS>\nCheck tenant isolation.\n<END_REPOSITORY_INSTRUCTIONS>';
		const body = {
			agent: 'reviewer',
			tools: nativeReviewTools,
			noReply: true,
			model: { providerID: 'openai', modelID: 'gpt-5.5' },
			parts: [
				{
					type: 'text' as const,
					text: `Server protocol check.\n${instructionText}`,
				},
			],
			format: {
				type: 'json_schema',
				retryCount: 4,
				schema: reviewIssuesEnvelopeJsonSchema,
			},
		};
		const { data: user } = await runAsyncPrompt(sdk, sessionId, body, {
			signal: AbortSignal.timeout(15_000),
			label: 'OpenCode protocol check',
			pollIntervalMs: 100,
			getRecentServerOutput: () => client!.getDiagnostics().recentServerOutput,
		});
		assert.deepEqual(
			user.info.format,
			body.format,
			'JSON schema did not survive the native event round trip.',
		);
		assert.ok(user.parts.some(part => part.text?.includes(instructionText)));
		await client.deleteSession(sessionId);
		assert.equal(
			modelRequests,
			0,
			'The protocol check unexpectedly invoked a model.',
		);
		mockGeneration = true;
		const structuredSession = await client.createSession(
			'native-structured-check',
		);
		const structured = await runAsyncPrompt(
			sdk,
			structuredSession,
			{
				...body,
				noReply: false,
				parts: [
					{
						type: 'text',
						text: 'Protocol check only: call StructuredOutput with the schema-shaped findings. Do not inspect or modify files.',
					},
				],
			},
			{
				signal: AbortSignal.timeout(30_000),
				label: 'OpenCode native structured check',
				pollIntervalMs: 100,
				getRecentServerOutput: () =>
					client!.getDiagnostics().recentServerOutput,
			},
		);
		const payload =
			structured.data.info.structured ?? structured.data.info.structured_output;
		assert.deepEqual(
			reviewIssuesEnvelopeSchema.parse(payload),
			findings,
			'Native structured findings did not arrive through session events.',
		);
		assert.ok(
			filteredToolsVerified,
			'The model must receive only filtered context tools and StructuredOutput.',
		);
		assert.ok(
			applicationContextSeen,
			'Native tools must return application code to the model.',
		);
		assert.equal(
			contextLeak,
			false,
			'Test contents leaked through native context tools.',
		);
		assert.equal(
			modelRequests,
			5,
			'The native glob/grep/read checks did not all execute.',
		);
		await client.deleteSession(structuredSession);
		console.log(
			`OpenCode ${expectedVersion} startup check passed: isolated reviewer config, sessions, JSON schema round trip and native StructuredOutput; only loopback mock-provider requests=${modelRequests}.`,
		);
	} catch (error) {
		if (client) console.error(client.getDiagnostics().recentServerOutput);
		throw error;
	} finally {
		await client?.close();
		gateway.closeAllConnections();
		await new Promise<void>(resolve => gateway.close(() => resolve()));
		for (const name of [
			'XDG_CONFIG_HOME',
			'OPENCODE_TEST_HOME',
			'OPENCODE_CONFIG',
			'OPENAI_API_KEY',
			'OPENCODE_DISABLE_MODELS_FETCH',
		]) {
			if (previousEnv[name] === undefined) delete process.env[name];
			else process.env[name] = previousEnv[name];
		}
		await rm(fixture, { recursive: true, force: true });
	}
}

try {
	await checkServer();
} catch (error) {
	console.error(
		error instanceof Error ? (error.stack ?? error.message) : String(error),
	);
	process.exitCode = 1;
}
await Promise.all(
	[process.stdout, process.stderr].map(
		stream => new Promise<void>(resolve => stream.write('', () => resolve())),
	),
);
process.exit(process.exitCode ?? 0);
