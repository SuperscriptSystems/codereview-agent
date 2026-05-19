import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadRawConfigMock = vi.fn();
const parseConfigMock = vi.fn();
const getDiffMock = vi.fn();
const getCommitMessagesMock = vi.fn();
const getStagedDiffContentMock = vi.fn();
const filterTestFilesMock = vi.fn();
const isFrontendNoiseFileMock = vi.fn();
const isLockfileMock = vi.fn();
const shouldIgnorePathMock = vi.fn();
const parseChangedFilesFromDiffMock = vi.fn();
const createSessionClientMock = vi.fn();
const buildReviewBatchesMock = vi.fn();
const runReviewMock = vi.fn();
const handlePrResultsMock = vi.fn();
const cleanupAndPostAllCommentsMock = vi.fn();

vi.mock('../../src/config/load-config.js', () => ({
	loadRawConfig: loadRawConfigMock,
	parseConfig: parseConfigMock,
}));

vi.mock('../../src/git/diff.js', () => ({
	getDiff: getDiffMock,
	getCommitMessages: getCommitMessagesMock,
	getStagedDiffContent: getStagedDiffContentMock,
}));

vi.mock('../../src/git/filtering.js', () => ({
	filterTestFiles: filterTestFilesMock,
	isFrontendNoiseFile: isFrontendNoiseFileMock,
	isLockfile: isLockfileMock,
	shouldIgnorePath: shouldIgnorePathMock,
}));

vi.mock('../../src/git/parse.js', () => ({
	parseChangedFilesFromDiff: parseChangedFilesFromDiffMock,
}));

vi.mock('../../src/opencode/client.js', () => ({
	createSessionClient: createSessionClientMock,
}));

vi.mock('../../src/review/reviewer.js', () => ({
	buildReviewBatches: buildReviewBatchesMock,
	runReview: runReviewMock,
}));

vi.mock('../../src/integrations/github.js', () => ({
	handlePrResults: handlePrResultsMock,
}));

vi.mock('../../src/integrations/bitbucket.js', () => ({
	cleanupAndPostAllComments: cleanupAndPostAllCommentsMock,
}));

const loggerFns = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

vi.mock('../../src/core/logger.js', () => ({
	configureLogger: vi.fn(),
	logger: loggerFns,
}));

const { runReviewCommand } = await import('../../src/commands/review.js');

describe('review command', () => {
	const sessionClient = {
		createSession: vi.fn(),
		promptText: vi.fn(),
		close: vi.fn().mockResolvedValue(undefined),
	};

	beforeEach(() => {
		vi.clearAllMocks();

		loadRawConfigMock.mockResolvedValue({ agent: {} });
		parseConfigMock.mockReturnValue({
			review: {
				focusAreas: ['LogicError', 'Security'],
				customRules: ['Project rule'],
				failOpen: false,
				batchTimeoutMs: 120000,
				structuredOutputRetryCount: 10,
				testKeywords: ['test', 'spec'],
				batching: {
					enabled: true,
					maxFilesPerBatch: 5,
					maxDiffCharsPerBatch: 40000,
				},
				filtering: {
					ignoredExtensions: [],
					ignoredPaths: [],
					ignoredPatterns: ['package-lock.json'],
				},
				lockfiles: { excludeFromReview: true, logExcluded: true },
				noiseFiles: { excludeFromReview: true, logExcluded: true },
			},
		});

		filterTestFilesMock.mockImplementation(value => value);
		isFrontendNoiseFileMock.mockReturnValue(false);
		isLockfileMock.mockReturnValue(false);
		shouldIgnorePathMock.mockReturnValue(false);
		buildReviewBatchesMock.mockImplementation(value => [value]);
		createSessionClientMock.mockResolvedValue(sessionClient);
		runReviewMock.mockResolvedValue({});

		delete process.env.GITHUB_ACTIONS;
		delete process.env.GITHUB_PR_NUMBER;
		delete process.env.BITBUCKET_PR_ID;
	});

	afterEach(() => {
		delete process.env.GITHUB_ACTIONS;
		delete process.env.GITHUB_PR_NUMBER;
		delete process.env.BITBUCKET_PR_ID;
	});

	it('passes staged review inputs through the new runReview shape', async () => {
		getStagedDiffContentMock.mockResolvedValue({
			changedFilesMap: {
				'src/app.ts': 'diff-app',
				'src/app.test.ts': 'diff-test',
			},
			changedFilesContent: { 'src/app.ts': 'content' },
		});
		filterTestFilesMock.mockReturnValue({ 'src/app.ts': 'diff-app' });
		runReviewMock.mockResolvedValue({ 'src/app.ts': { issues: [] } });

		await runReviewCommand({
			repoPath: '/repo',
			baseRef: 'origin/main',
			headRef: 'HEAD',
			staged: true,
			focus: undefined,
			trace: false,
		});

		expect(runReviewMock).toHaveBeenCalledWith(sessionClient, {
			repoPath: '/repo',
			staged: true,
			baseRef: 'origin/main',
			headRef: 'HEAD',
			changedFilesMap: { 'src/app.ts': 'diff-app' },
			commitMessages: 'Reviewing staged files before commit.',
			jiraDetails: '',
			reviewRules: ['Project rule'],
			focusAreas: ['LogicError', 'Security'],
			batching: {
				enabled: true,
				maxFilesPerBatch: 5,
				maxDiffCharsPerBatch: 40000,
			},
			batchTimeoutMs: 120000,
			structuredOutputRetryCount: 10,
		});
		expect(sessionClient.close).toHaveBeenCalled();
	});

	it('passes range review inputs through the new runReview shape', async () => {
		getDiffMock.mockResolvedValue('full diff text');
		parseChangedFilesFromDiffMock.mockReturnValue({
			'src/range.ts': 'range-diff',
		});
		getCommitMessagesMock.mockResolvedValue('commit one\n\ncommit two');
		runReviewMock.mockResolvedValue({ 'src/range.ts': { issues: [] } });

		await runReviewCommand({
			repoPath: '/repo',
			baseRef: 'main',
			headRef: 'feature',
			staged: false,
			focus: ['Security'],
			trace: false,
		});

		expect(runReviewMock).toHaveBeenCalledWith(
			sessionClient,
			expect.objectContaining({
				repoPath: '/repo',
				staged: false,
				baseRef: 'main',
				headRef: 'feature',
				changedFilesMap: { 'src/range.ts': 'range-diff' },
				commitMessages: 'commit one\n\ncommit two',
				focusAreas: ['Security'],
			}),
		);
	});

	it('returns early when no changed files exist', async () => {
		getStagedDiffContentMock.mockResolvedValue({
			changedFilesMap: {},
			changedFilesContent: {},
		});

		await runReviewCommand({
			repoPath: '/repo',
			baseRef: 'main',
			headRef: 'HEAD',
			staged: true,
			focus: undefined,
			trace: false,
		});

		expect(runReviewMock).not.toHaveBeenCalled();
		expect(createSessionClientMock).not.toHaveBeenCalled();
	});

	it('returns early when only filtered files remain', async () => {
		getDiffMock.mockResolvedValue('full diff text');
		parseChangedFilesFromDiffMock.mockReturnValue({ 'src/app.ts': 'app-diff' });
		getCommitMessagesMock.mockResolvedValue('commit');
		shouldIgnorePathMock.mockReturnValue(true);

		await runReviewCommand({
			repoPath: '/repo',
			baseRef: 'main',
			headRef: 'HEAD',
			staged: false,
			focus: undefined,
			trace: false,
		});

		expect(runReviewMock).not.toHaveBeenCalled();
		expect(createSessionClientMock).not.toHaveBeenCalled();
	});

	it('returns early when only excluded lockfiles remain', async () => {
		getDiffMock.mockResolvedValue('full diff text');
		parseChangedFilesFromDiffMock.mockReturnValue({
			'package-lock.json': 'lock-diff',
		});
		getCommitMessagesMock.mockResolvedValue('commit');
		isLockfileMock.mockReturnValue(true);

		await runReviewCommand({
			repoPath: '/repo',
			baseRef: 'main',
			headRef: 'HEAD',
			staged: false,
			focus: undefined,
			trace: false,
		});

		expect(loggerFns.info).toHaveBeenCalledWith(
			'Only excluded lockfiles or frontend noise files changed; application-code review skipped.',
		);
		expect(runReviewMock).not.toHaveBeenCalled();
		expect(createSessionClientMock).not.toHaveBeenCalled();
	});

	it('logs excluded files and batch counts', async () => {
		getDiffMock.mockResolvedValue('full diff text');
		parseChangedFilesFromDiffMock.mockReturnValue({
			'src/app.ts': 'app-diff',
			'package-lock.json': 'lock-diff',
			'src/Button.stories.tsx': 'story-diff',
		});
		getCommitMessagesMock.mockResolvedValue('commit');
		isLockfileMock.mockImplementation(
			(filePath: string) => filePath === 'package-lock.json',
		);
		isFrontendNoiseFileMock.mockImplementation(
			(filePath: string) => filePath === 'src/Button.stories.tsx',
		);
		buildReviewBatchesMock.mockReturnValue([{ 'src/app.ts': 'app-diff' }]);
		runReviewMock.mockResolvedValue({ 'src/app.ts': { issues: [] } });

		await runReviewCommand({
			repoPath: '/repo',
			baseRef: 'main',
			headRef: 'HEAD',
			staged: false,
			focus: undefined,
			trace: false,
		});

		expect(loggerFns.info).toHaveBeenCalledWith(
			'Excluded lockfiles: package-lock.json',
		);
		expect(loggerFns.info).toHaveBeenCalledWith(
			'Excluded frontend noise files: src/Button.stories.tsx',
		);
		expect(loggerFns.info).toHaveBeenCalledWith('Review batches: 1');
		expect(loggerFns.info).toHaveBeenCalledWith(
			'Batch 1: 1 files, 8 diff chars',
		);
	});

	it('rethrows review execution failures after logging', async () => {
		getDiffMock.mockResolvedValue('full diff text');
		parseChangedFilesFromDiffMock.mockReturnValue({
			'src/app.ts': 'range-diff',
		});
		getCommitMessagesMock.mockResolvedValue('commit');
		runReviewMock.mockRejectedValue(new Error('Unauthorized'));

		await expect(
			runReviewCommand({
				repoPath: '/repo',
				baseRef: 'main',
				headRef: 'HEAD',
				staged: false,
				focus: undefined,
				trace: false,
			}),
		).rejects.toThrow('Unauthorized');

		expect(loggerFns.error).toHaveBeenCalledWith(
			'Verify OpenCode provider auth, model configuration, and custom agent registration before running the full review flow.',
		);
		expect(sessionClient.close).toHaveBeenCalled();
	});

	it('skips review failures when fail-open is enabled', async () => {
		parseConfigMock.mockReturnValue({
			review: {
				focusAreas: ['LogicError', 'Security'],
				customRules: ['Project rule'],
				failOpen: true,
				batchTimeoutMs: 120000,
				structuredOutputRetryCount: 10,
				testKeywords: ['test', 'spec'],
				batching: {
					enabled: true,
					maxFilesPerBatch: 5,
					maxDiffCharsPerBatch: 40000,
				},
				filtering: {
					ignoredExtensions: [],
					ignoredPaths: [],
					ignoredPatterns: ['package-lock.json'],
				},
				lockfiles: { excludeFromReview: true, logExcluded: true },
				noiseFiles: { excludeFromReview: true, logExcluded: true },
			},
		});
		getDiffMock.mockResolvedValue('full diff text');
		parseChangedFilesFromDiffMock.mockReturnValue({
			'src/app.ts': 'range-diff',
		});
		getCommitMessagesMock.mockResolvedValue('commit');
		runReviewMock.mockRejectedValue(new Error('fetch failed'));

		await expect(
			runReviewCommand({
				repoPath: '/repo',
				baseRef: 'main',
				headRef: 'HEAD',
				staged: false,
				focus: undefined,
				trace: false,
			}),
		).resolves.toBeUndefined();

		expect(loggerFns.warn).toHaveBeenCalledWith(
			'Review is configured to fail open. Skipping review failure so the pipeline can continue.',
		);
		expect(sessionClient.close).toHaveBeenCalled();
	});

	it('publishes GitHub results after review completes', async () => {
		process.env.GITHUB_ACTIONS = 'true';
		process.env.GITHUB_PR_NUMBER = '15';

		getDiffMock.mockResolvedValue('full diff text');
		parseChangedFilesFromDiffMock.mockReturnValue({
			'src/app.ts': 'range-diff',
		});
		getCommitMessagesMock.mockResolvedValue('commit');
		runReviewMock.mockResolvedValue({
			'src/app.ts': {
				issues: [
					{
						filePath: 'src/app.ts',
						lineNumber: 8,
						issueType: 'LogicError',
						comment: 'Broken behavior',
					},
				],
			},
		});

		await runReviewCommand({
			repoPath: '/repo',
			baseRef: 'main',
			headRef: 'HEAD',
			staged: false,
			focus: undefined,
			trace: false,
		});

		expect(handlePrResultsMock).toHaveBeenCalledWith(
			[
				{
					filePath: 'src/app.ts',
					lineNumber: 8,
					issueType: 'LogicError',
					comment: 'Broken behavior',
				},
			],
			{
				'src/app.ts': [
					{
						filePath: 'src/app.ts',
						lineNumber: 8,
						issueType: 'LogicError',
						comment: 'Broken behavior',
					},
				],
			},
		);
	});

	it('does not depend on legacy context expansion imports in the primary path', async () => {
		const commandSource = await import('node:fs/promises').then(
			({ readFile }) =>
				readFile(
					new URL('../../src/commands/review.ts', import.meta.url),
					'utf8',
				),
		);

		expect(commandSource).not.toContain('from "../review/context-builder.js"');
		expect(commandSource).not.toContain('buildChangedFilesContent');
		expect(commandSource).not.toContain('getFileStructure');
		expect(commandSource).not.toContain('determineContext(');
	});
});
