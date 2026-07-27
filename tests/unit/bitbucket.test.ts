import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeIssue } from '../../src/core/models.js';
import { cleanupAndPostAllComments } from '../../src/integrations/bitbucket.js';

function makeResponse(
	status: number,
	jsonData?: unknown,
	text?: string,
): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => text ?? (jsonData ? JSON.stringify(jsonData) : ''),
		json: async () => jsonData,
	} as Response;
}

describe('bitbucket integration', () => {
	const originalFetch = global.fetch;
	const originalConsoleLog = console.log;
	const originalConsoleWarn = console.warn;
	let consoleLogSpy: ReturnType<typeof vi.fn>;
	let consoleWarnSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		delete process.env.BITBUCKET_ACCESS_TOKEN;
		delete process.env.BITBUCKET_TOKEN;
		delete process.env.BITBUCKET_USER_EMAIL;
		process.env.BITBUCKET_APP_USERNAME = 'user';
		process.env.BITBUCKET_APP_PASSWORD = 'pass';
		process.env.BITBUCKET_WORKSPACE = 'workspace';
		process.env.BITBUCKET_REPO_SLUG = 'repo';
		process.env.BITBUCKET_PR_ID = '7';
		consoleLogSpy = vi.fn();
		consoleWarnSpy = vi.fn();
		console.log = consoleLogSpy;
		console.warn = consoleWarnSpy;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		console.log = originalConsoleLog;
		console.warn = originalConsoleWarn;
		vi.restoreAllMocks();
	});

	it('approves pull request when there are no issues', async () => {
		const calls: Array<{
			url: string;
			method: string;
			body?: string;
			contentType?: string;
			authorization?: string;
		}> = [];

		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const body = typeof init?.body === 'string' ? init.body : undefined;
			const contentType =
				new Headers(init?.headers).get('Content-Type') ?? undefined;
			const authorization =
				new Headers(init?.headers).get('Authorization') ?? undefined;
			calls.push({ url, method, body, contentType, authorization });

			if (url.endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (url.includes('/comments') && method === 'GET') {
				return makeResponse(200, { values: [] });
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await cleanupAndPostAllComments([], {});

		expect(
			calls.some(
				call => call.url.endsWith('/approve') && call.method === 'POST',
			),
		).toBe(true);
		expect(
			calls.find(
				call => call.url.endsWith('/approve') && call.method === 'POST',
			)?.contentType,
		).toBeUndefined();
		expect(
			calls.some(
				call => call.url.endsWith('/pullrequests/7') && call.method === 'GET',
			),
		).toBe(false);
		expect(
			calls.find(
				call =>
					call.url.includes('/comments') &&
					call.body?.includes("didn't find any issues"),
			)?.contentType,
		).toBe('application/json');
		expect(calls[0]?.authorization).toBe(
			`Basic ${Buffer.from('user:pass').toString('base64')}`,
		);
		expect(
			calls.some(
				call =>
					call.url.includes('/comments') &&
					call.body?.includes("didn't find any issues"),
			),
		).toBe(true);
	});

	it('uses basic auth for Atlassian API token when email is provided', async () => {
		process.env.BITBUCKET_TOKEN = 'scoped-token';
		process.env.BITBUCKET_USER_EMAIL = 'bot@example.com';
		delete process.env.BITBUCKET_APP_USERNAME;
		delete process.env.BITBUCKET_APP_PASSWORD;

		const authorizations: string[] = [];

		global.fetch = vi.fn(async (_input, init) => {
			authorizations.push(
				new Headers(init?.headers).get('Authorization') ?? '',
			);

			if (String(_input).endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (
				String(_input).includes('/comments') &&
				(init?.method ?? 'GET') === 'GET'
			) {
				return makeResponse(200, { values: [] });
			}

			if (
				String(_input).endsWith('/approve') &&
				(init?.method ?? 'GET') === 'POST'
			) {
				return makeResponse(200, { approved: true });
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await cleanupAndPostAllComments([], {});

		expect(authorizations.length).toBeGreaterThan(0);
		expect(
			authorizations.every(
				value =>
					value ===
					`Basic ${Buffer.from('bot@example.com:scoped-token').toString('base64')}`,
			),
		).toBe(true);
	});

	it('uses bearer auth for Bitbucket access tokens', async () => {
		process.env.BITBUCKET_ACCESS_TOKEN = 'access-token';
		delete process.env.BITBUCKET_APP_USERNAME;
		delete process.env.BITBUCKET_APP_PASSWORD;

		const authorizations: string[] = [];

		global.fetch = vi.fn(async (_input, init) => {
			authorizations.push(
				new Headers(init?.headers).get('Authorization') ?? '',
			);

			if (String(_input).endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (
				String(_input).includes('/comments') &&
				(init?.method ?? 'GET') === 'GET'
			) {
				return makeResponse(200, { values: [] });
			}

			if (
				String(_input).endsWith('/approve') &&
				(init?.method ?? 'GET') === 'POST'
			) {
				return makeResponse(200, { approved: true });
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await cleanupAndPostAllComments([], {});

		expect(authorizations.length).toBeGreaterThan(0);
		expect(authorizations.every(value => value === 'Bearer access-token')).toBe(
			true,
		);
	});

	it('throws a clear error when no Bitbucket auth is configured', async () => {
		delete process.env.BITBUCKET_TOKEN;
		delete process.env.BITBUCKET_APP_USERNAME;
		delete process.env.BITBUCKET_APP_PASSWORD;

		await expect(cleanupAndPostAllComments([], {})).rejects.toThrow(
			'Bitbucket credentials are not configured. Set BITBUCKET_ACCESS_TOKEN, or BITBUCKET_TOKEN with BITBUCKET_USER_EMAIL, or BITBUCKET_APP_USERNAME and BITBUCKET_APP_PASSWORD.',
		);
	});

	it('posts inline comments, summary, and approves when issues exist', async () => {
		const issue: CodeIssue = {
			filePath: 'src/main.ts',
			lineNumber: 12,
			issueType: 'Security',
			comment: 'Unsafe behavior',
		};
		const calls: Array<{ url: string; method: string; body?: string }> = [];

		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const body = typeof init?.body === 'string' ? init.body : undefined;
			calls.push({ url, method, body });

			if (url.endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (url.includes('/comments') && method === 'GET') {
				return makeResponse(200, { values: [] });
			}

			if (url.endsWith('/approve') && method === 'POST') {
				return makeResponse(200, { approved: true });
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await cleanupAndPostAllComments([issue], { 'src/main.ts': [issue] });

		expect(
			calls.some(
				call => call.url.endsWith('/approve') && call.method === 'POST',
			),
		).toBe(true);
		expect(
			calls.some(
				call =>
					call.url.includes('/comments') &&
					call.body?.includes('Unsafe behavior'),
			),
		).toBe(true);
		expect(
			calls.some(
				call =>
					call.url.includes('/comments') &&
					call.body?.includes('AI Code Review Summary'),
			),
		).toBe(true);
	});

	it('does not fail when approving a pull request with issues returns 400', async () => {
		const issue: CodeIssue = {
			filePath: 'src/main.ts',
			lineNumber: 12,
			issueType: 'Security',
			comment: 'Unsafe behavior',
		};

		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';

			if (url.endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (url.includes('/comments') && method === 'GET') {
				return makeResponse(200, { values: [] });
			}

			if (url.endsWith('/approve') && method === 'POST') {
				return makeResponse(400, undefined, 'Approval not allowed');
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await expect(
			cleanupAndPostAllComments([issue], { 'src/main.ts': [issue] }),
		).resolves.toBeUndefined();
	});

	it('does not fail when approving a pull request returns 400', async () => {
		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';

			if (url.endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (url.includes('/comments') && method === 'GET') {
				return makeResponse(200, { values: [] });
			}

			if (url.endsWith('/approve') && method === 'POST') {
				return makeResponse(400, undefined, 'Approval not allowed');
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await expect(cleanupAndPostAllComments([], {})).resolves.toBeUndefined();
		expect(consoleWarnSpy).toHaveBeenCalledWith(
			'[warn] Bitbucket could not approve for this pull request: Approval not allowed',
		);
	});

	it('does not fail when approving a pull request returns 403', async () => {
		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';

			if (url.endsWith('/user')) {
				return makeResponse(200, {
					account_id: 'acct-1',
					display_name: 'Reviewer Bot',
				});
			}

			if (url.endsWith('/pullrequests/7') && method === 'GET') {
				return makeResponse(200, { author: { account_id: 'acct-2' } });
			}

			if (url.includes('/comments') && method === 'GET') {
				return makeResponse(200, { values: [] });
			}

			if (url.endsWith('/approve') && method === 'POST') {
				return makeResponse(403, undefined, 'Forbidden');
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await expect(cleanupAndPostAllComments([], {})).resolves.toBeUndefined();
		expect(consoleWarnSpy).toHaveBeenCalledWith(
			'[warn] Bitbucket could not approve for this pull request: Forbidden',
		);
	});

	it('does not fail when approval endpoints return plain-text error bodies', async () => {
		const issue: CodeIssue = {
			filePath: 'src/main.ts',
			lineNumber: 12,
			issueType: 'Security',
			comment: 'Unsafe behavior',
		};

		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';

			if (url.endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (url.includes('/comments') && method === 'GET') {
				return makeResponse(200, { values: [] });
			}

			if (url.endsWith('/approve')) {
				return makeResponse(400, undefined, 'Bad Request');
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await expect(
			cleanupAndPostAllComments([issue], { 'src/main.ts': [issue] }),
		).resolves.toBeUndefined();
		await expect(cleanupAndPostAllComments([], {})).resolves.toBeUndefined();
	});

	it('logs approval success when no issues are found and approval succeeds', async () => {
		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';

			if (url.endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (url.includes('/comments') && method === 'GET') {
				return makeResponse(200, { values: [] });
			}

			if (url.endsWith('/approve') && method === 'POST') {
				return makeResponse(200, { approved: true });
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await cleanupAndPostAllComments([], {});

		expect(consoleLogSpy).toHaveBeenCalledWith(
			'Bitbucket pull request approved.',
		);
	});

	it('cleans up bot comments across paginated comment results', async () => {
		const calls: Array<{ url: string; method: string; body?: string }> = [];

		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const body = typeof init?.body === 'string' ? init.body : undefined;
			calls.push({ url, method, body });

			if (url.endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (url.endsWith('/pullrequests/7/comments') && method === 'GET') {
				return makeResponse(200, {
					values: [{ id: 101, user: { account_id: 'acct-1' } }],
					next: 'https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests/7/comments?page=2',
				});
			}

			if (url.endsWith('/comments?page=2') && method === 'GET') {
				return makeResponse(200, {
					values: [{ id: 202, user: { account_id: 'acct-1' } }],
				});
			}

			return makeResponse(204);
		}) as typeof fetch;

		await cleanupAndPostAllComments([], {});

		expect(
			calls.some(
				call => call.url.endsWith('/comments/101') && call.method === 'DELETE',
			),
		).toBe(true);
		expect(
			calls.some(
				call => call.url.endsWith('/comments/202') && call.method === 'DELETE',
			),
		).toBe(true);
	});

	it('continues when deleting a previous bot comment returns 500', async () => {
		const calls: Array<{ url: string; method: string; body?: string }> = [];

		global.fetch = vi.fn(async (input, init) => {
			const url = String(input);
			const method = init?.method ?? 'GET';
			const body = typeof init?.body === 'string' ? init.body : undefined;
			calls.push({ url, method, body });

			if (url.endsWith('/user')) {
				return makeResponse(200, { account_id: 'acct-1' });
			}

			if (url.endsWith('/pullrequests/7/comments') && method === 'GET') {
				return makeResponse(200, {
					values: [{ id: 101, user: { account_id: 'acct-1' } }],
				});
			}

			if (url.endsWith('/comments/101') && method === 'DELETE') {
				return makeResponse(500, undefined, 'Internal Server Error');
			}

			if (url.endsWith('/approve') && method === 'POST') {
				return makeResponse(200, { approved: true });
			}

			return makeResponse(201, { id: 1 });
		}) as typeof fetch;

		await expect(cleanupAndPostAllComments([], {})).resolves.toBeUndefined();
		expect(
			calls.some(
				call => call.url.endsWith('/comments/101') && call.method === 'DELETE',
			),
		).toBe(true);
		expect(
			calls.some(
				call =>
					call.url.includes('/comments') &&
					call.body?.includes("didn't find any issues"),
			),
		).toBe(true);
		expect(consoleWarnSpy).toHaveBeenCalledWith(
			'[warn] Bitbucket could not delete previous bot comment 101; continuing cleanup: 500 Internal Server Error',
		);
	});
});
