import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerFns = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

vi.mock('../../src/core/logger.js', () => ({
	logger: loggerFns,
}));

const { loadRawConfig } = await import('../../src/config/load-config.js');

describe('loadRawConfig', () => {
	let repoPath: string | undefined;

	afterEach(async () => {
		vi.clearAllMocks();
		if (repoPath) {
			await rm(repoPath, { recursive: true, force: true });
			repoPath = undefined;
		}
	});

	it('ignores repo-local opencode.json and keeps bundled runtime config', async () => {
		repoPath = await mkdtemp(path.join(tmpdir(), 'code-review-agent-config-'));

		await writeFile(
			path.join(repoPath, 'opencode.json'),
			JSON.stringify({ model: 'openai/should-not-be-used', instructions: ['repo-local.md'] }),
			'utf8',
		);
		await writeFile(
			path.join(repoPath, 'review-config.json'),
			JSON.stringify({ failOpen: false, batchTimeoutMs: 12345 }),
			'utf8',
		);

		const rawConfig = await loadRawConfig(repoPath);
		const bundledConfigPath = fileURLToPath(new URL('../../opencode.json', import.meta.url));
		const bundledConfig = JSON.parse(await readFile(bundledConfigPath, 'utf8')) as Record<string, unknown>;

		expect(rawConfig.model).toBe(bundledConfig.model);
		expect(rawConfig).not.toMatchObject({
			model: 'openai/should-not-be-used',
			instructions: ['repo-local.md'],
		});
		expect(rawConfig.review).toMatchObject({
			failOpen: false,
			batchTimeoutMs: 12345,
		});
		expect(rawConfig.__configDir).toBe(path.dirname(bundledConfigPath));
	});
});
