import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNativeFileGuard } from '../../src/opencode/native-file-guard.js';

describe('native OpenCode file guard', () => {
	let root: string;
	let guard: Awaited<ReturnType<typeof createNativeFileGuard>>;
	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'native-file-guard-'));
		await mkdir(path.join(root, 'src'));
		await writeFile(path.join(root, 'src/Handler.cs'), 'application');
		await writeFile(path.join(root, 'src/HandlerTests.cs'), 'TEST_SECRET');
		await writeFile(
			path.join(root, 'src/Handler.checks.cs'),
			'CUSTOM_TEST_SECRET',
		);
		await writeFile(path.join(root, 'src/ignored.cs'), 'IGNORED_SECRET');
		await symlink('HandlerTests.cs', path.join(root, 'src/alias.cs'));
		guard = await createNativeFileGuard(root, {
			testKeywords: ['checks'],
			filtering: {
				ignoredExtensions: [],
				ignoredPaths: [],
				ignoredPatterns: ['ignored.cs'],
			},
		});
	});
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const before = (tool: string, args: Record<string, unknown>) =>
		guard['tool.execute.before']({ tool }, { args });
	it('allows native reading and searching of application files', async () => {
		await expect(
			before('read', { filePath: 'src/Handler.cs' }),
		).resolves.toBeUndefined();
		await expect(
			before('grep', { path: 'src', pattern: 'Handler' }),
		).resolves.toBeUndefined();
		await expect(
			before('glob', { pattern: '**/*.cs' }),
		).resolves.toBeUndefined();
	});
	it.each([
		'src/HandlerTests.cs',
		'src/Handler.checks.cs',
		'src/ignored.cs',
		'src/alias.cs',
		'/etc/passwd',
		'../outside.cs',
	])('blocks direct native access to %s', async filePath => {
		await expect(before('read', { filePath })).rejects.toThrow('excluded');
		await expect(
			before('grep', { path: filePath, pattern: 'secret' }),
		).rejects.toThrow('excluded');
	});
	it.each(['bash', 'task', 'lsp'])('blocks bypass through %s', async tool => {
		await expect(before(tool, {})).rejects.toThrow('Only native');
	});
	it('removes test content and paths from native grep output', async () => {
		const output = {
			output: `Found 3 matches\n${root}/src/HandlerTests.cs:\n  Line 1: TEST_SECRET\n${root}/src/Handler.cs:\n  Line 1: application\n${root}/src/alias.cs:\n  Line 1: TEST_SECRET`,
			metadata: {},
		};
		await guard['tool.execute.after']({ tool: 'grep' }, output);
		expect(output.output).toContain('application');
		expect(output.output).not.toContain('TEST_SECRET');
		expect(output.output).not.toContain('HandlerTests');
		expect(output.output).not.toContain('alias');
	});
	it('removes tests from native glob output', async () => {
		const output = {
			output: `${root}/src/HandlerTests.cs\n${root}/src/Handler.cs\n${root}/src/alias.cs`,
			metadata: {},
		};
		await guard['tool.execute.after']({ tool: 'glob' }, output);
		expect(output.output).toBe(`${root}/src/Handler.cs`);
	});
	it('filters directory reads while preserving application entries', async () => {
		const output = { output: 'native directory listing', metadata: {} };
		await guard['tool.execute.after'](
			{ tool: 'read', args: { filePath: 'src' } },
			output,
		);
		expect(output.output).toContain('Handler.cs');
		expect(output.output).not.toContain('HandlerTests');
		expect(output.output).not.toContain('checks');
		expect(output.output).not.toContain('alias');
	});
});
