import path from 'node:path';

import { loadRawConfig, parseConfig } from '../config/load-config.js';
import { configureLogger, logger } from '../core/logger.js';
import type { IssueType } from '../core/models.js';
import {
	getCommitMessages,
	getDiff,
	getStagedDiffContent,
} from '../git/diff.js';
import {
	filterTestFiles,
	isFrontendNoiseFile,
	isLockfile,
	shouldIgnorePath,
} from '../git/filtering.js';
import { parseChangedFilesFromDiff } from '../git/parse.js';
import { cleanupAndPostAllComments } from '../integrations/bitbucket.js';
import { handlePrResults } from '../integrations/github.js';
import { createSessionClient } from '../opencode/client.js';
import { buildReviewBatches, runReview } from '../review/reviewer.js';

export interface ReviewCommandOptions {
	repoPath: string;
	baseRef: string;
	headRef: string;
	staged: boolean;
	focus?: string[];
	trace: boolean;
}

export async function runReviewCommand(
	options: ReviewCommandOptions,
): Promise<void> {
	configureLogger(options.trace);

	const repoPath = path.resolve(options.repoPath);
	const rawConfig = await loadRawConfig(repoPath);
	const config = parseConfig(rawConfig);

	const focusAreas = resolveFocusAreas(options.focus, config.review.focusAreas);
	const filtering = config.review.filtering;

	const { changedFilesMap, commitMessages } = await collectReviewInputs(
		repoPath,
		options,
	);

	if (Object.keys(changedFilesMap).length === 0) {
		logger.info('No changed files detected to review.');
		return;
	}

	let filteredChangedFilesMap = filterTestFiles(
		changedFilesMap,
		config.review.testKeywords,
	);
	filteredChangedFilesMap = Object.fromEntries(
		Object.entries(filteredChangedFilesMap).filter(
			([filePath]) => !shouldIgnorePath(filePath, filtering),
		),
	);

	const lockfiles = Object.keys(filteredChangedFilesMap).filter(filePath =>
		isLockfile(filePath),
	);
	const noiseFiles = Object.keys(filteredChangedFilesMap).filter(filePath =>
		isFrontendNoiseFile(filePath),
	);

	if (config.review.lockfiles.excludeFromReview) {
		filteredChangedFilesMap = Object.fromEntries(
			Object.entries(filteredChangedFilesMap).filter(
				([filePath]) => !isLockfile(filePath),
			),
		);
	}

	if (config.review.noiseFiles.excludeFromReview) {
		filteredChangedFilesMap = Object.fromEntries(
			Object.entries(filteredChangedFilesMap).filter(
				([filePath]) => !isFrontendNoiseFile(filePath),
			),
		);
	}

	if (Object.keys(filteredChangedFilesMap).length === 0) {
		if (lockfiles.length > 0 || noiseFiles.length > 0) {
			logger.info(
				'Only excluded lockfiles or frontend noise files changed; application-code review skipped.',
			);
		}

		logger.info('No non-test files remain after filtering.');
		return;
	}

	logger.info(`Repo: ${repoPath}`);
	logger.info(
		`Mode: ${options.staged ? 'staged' : `${options.baseRef}..${options.headRef}`}`,
	);
	logger.info(`Changed files: ${Object.keys(changedFilesMap).length}`);
	logger.info(
		`Files after filtering: ${Object.keys(filteredChangedFilesMap).length}`,
	);
	if (
		config.review.lockfiles.excludeFromReview &&
		config.review.lockfiles.logExcluded &&
		lockfiles.length > 0
	) {
		logger.info(`Excluded lockfiles: ${lockfiles.join(', ')}`);
	}
	if (
		config.review.noiseFiles.excludeFromReview &&
		config.review.noiseFiles.logExcluded &&
		noiseFiles.length > 0
	) {
		logger.info(`Excluded frontend noise files: ${noiseFiles.join(', ')}`);
	}
	if (config.review.batching.enabled) {
		const batches = buildReviewBatches(
			filteredChangedFilesMap,
			config.review.batching,
		);
		logger.info(`Review batches: ${batches.length}`);
		for (const [index, batch] of batches.entries()) {
			const diffChars = Object.values(batch).reduce(
				(total, diff) => total + diff.length,
				0,
			);
			logger.info(
				`Batch ${index + 1}: ${Object.keys(batch).length} files, ${diffChars} diff chars`,
			);
		}
	}
	logger.info(`Focus: ${focusAreas.join(', ')}`);
	logger.info(`Custom rules: ${config.review.customRules.length}`);
	logger.info(`Batch timeout: ${config.review.batchTimeoutMs}ms`);
	logger.info(
		`Structured output retry count: ${config.review.structuredOutputRetryCount}`,
	);

	const sessionClient = await createSessionClient(rawConfig, repoPath);

	try {
		const reviewResults = await runReview(sessionClient, {
			repoPath,
			staged: options.staged,
			baseRef: options.baseRef,
			headRef: options.headRef,
			changedFilesMap: filteredChangedFilesMap,
			commitMessages,
			jiraDetails: '',
			reviewRules: config.review.customRules,
			focusAreas,
			failOpen: config.review.failOpen,
			batching: config.review.batching,
			batchTimeoutMs: config.review.batchTimeoutMs,
			structuredOutputRetryCount: config.review.structuredOutputRetryCount,
		});

		const issueCount = Object.values(reviewResults).reduce(
			(count, result) => count + result.issues.length,
			0,
		);
		const filesWithIssues = Object.fromEntries(
			Object.entries(reviewResults)
				.filter(([, result]) => result.issues.length > 0)
				.map(([filePath, result]) => [filePath, result.issues]),
		);
		const allIssues = Object.values(reviewResults).flatMap(
			result => result.issues,
		);

		if (isGithubPr()) {
			await handlePrResults(allIssues, filesWithIssues);
		} else if (isBitbucketPr()) {
			await cleanupAndPostAllComments(allIssues, filesWithIssues);
		}

		if (issueCount === 0) {
			logger.info('No issues found.');
			return;
		}

		for (const [filePath, issues] of Object.entries(filesWithIssues)) {
			if (issues.length === 0) {
				continue;
			}

			logger.info(`Issues in ${filePath}:`);
			for (const issue of issues) {
				logger.info(
					`  L${issue.lineNumber} [${issue.issueType}] ${issue.comment}`,
				);
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error(`OpenCode review execution failed: ${message}`);
		logger.error(
			'Verify OpenCode provider auth, model configuration, and custom agent registration before running the full review flow.',
		);

		if (config.review.failOpen) {
			logger.warn(
				'Review is configured to fail open. Skipping review failure so the pipeline can continue.',
			);
			return;
		}

		throw error;
	} finally {
		await sessionClient.close();
	}
}

function isGithubPr(): boolean {
	return Boolean(process.env.GITHUB_ACTIONS && process.env.GITHUB_PR_NUMBER);
}

function isBitbucketPr(): boolean {
	return Boolean(process.env.BITBUCKET_PR_ID);
}

function resolveFocusAreas(
	cliFocus: string[] | undefined,
	configFocus: IssueType[],
): IssueType[] {
	if (!cliFocus || cliFocus.length === 0) {
		return configFocus;
	}

	const allowed = new Set<IssueType>([
		'LogicError',
		'CodeStyle',
		'Security',
		'Suggestion',
		'TestCoverage',
		'Clarity',
		'Performance',
		'Other',
	]);

	const normalized = cliFocus
		.map(value =>
			[...allowed].find(
				candidate => candidate.toLowerCase() === value.toLowerCase(),
			),
		)
		.filter((value): value is IssueType => Boolean(value));

	return normalized.length > 0 ? normalized : configFocus;
}

async function collectReviewInputs(
	repoPath: string,
	options: ReviewCommandOptions,
): Promise<{
	changedFilesMap: Record<string, string>;
	commitMessages: string;
}> {
	if (options.staged) {
		const staged = await getStagedDiffContent(repoPath);
		return {
			changedFilesMap: staged.changedFilesMap,
			commitMessages: 'Reviewing staged files before commit.',
		};
	}

	const diff = await getDiff(repoPath, options.baseRef, options.headRef);
	return {
		changedFilesMap: parseChangedFilesFromDiff(diff),
		commitMessages: await getCommitMessages(
			repoPath,
			options.baseRef,
			options.headRef,
		),
	};
}
