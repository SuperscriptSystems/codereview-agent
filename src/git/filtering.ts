import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	ChangedFileMap,
	FilteringConfig,
	GeneratedFileConfig,
} from '../core/models.js';

const lockfileNames = new Set([
	'package-lock.json',
	'pnpm-lock.yaml',
	'yarn.lock',
	'npm-shrinkwrap.json',
	'packages.lock.json',
]);

export function filterTestFiles(
	changedFilesMap: ChangedFileMap,
	testKeywords: string[],
): ChangedFileMap {
	const keywords = testKeywords.map(keyword => keyword.toLowerCase());
	const filtered: ChangedFileMap = {};

	for (const [filePath, diff] of Object.entries(changedFilesMap)) {
		const parts = path
			.normalize(filePath)
			.split(path.sep)
			.map(part => part.toLowerCase());

		const matchesKeyword = parts.some(part =>
			keywords.some(
				keyword => part === keyword || part.includes(`.${keyword}.`),
			),
		);

		if (!matchesKeyword) {
			filtered[filePath] = diff;
		}
	}

	return filtered;
}

export function filterFilesByPattern(
	changedFilesMap: ChangedFileMap,
	ignoredPatterns: string[],
): ChangedFileMap {
	if (ignoredPatterns.length === 0) {
		return changedFilesMap;
	}

	const filtered: ChangedFileMap = {};

	for (const [filePath, diff] of Object.entries(changedFilesMap)) {
		const filename = path.basename(filePath);

		if (!ignoredPatterns.some(pattern => filename.includes(pattern))) {
			filtered[filePath] = diff;
		}
	}

	return filtered;
}

export function shouldIgnorePath(
	filePath: string,
	filtering: FilteringConfig,
): boolean {
	const normalizedPath = filePath.replaceAll('\\', '/');
	const pathParts = normalizedPath.split('/');
	const extension = path.extname(normalizedPath);
	const filename = path.basename(normalizedPath);

	return (
		filtering.ignoredExtensions.includes(extension) ||
		pathParts.some(part => filtering.ignoredPaths.includes(part)) ||
		filtering.ignoredPatterns.some(pattern => filename.includes(pattern))
	);
}

export function isLockfile(filePath: string): boolean {
	return lockfileNames.has(path.basename(filePath).toLowerCase());
}

export function isFrontendNoiseFile(filePath: string): boolean {
	const normalizedPath = filePath.replaceAll('\\', '/').toLowerCase();
	const filename = path.basename(normalizedPath);

	return (
		filename.endsWith('.snap') ||
		filename.includes('.stories.') ||
		filename.endsWith('.map')
	);
}

export async function isGeneratedFile(
	repoPath: string,
	filePath: string,
	config: GeneratedFileConfig,
): Promise<boolean> {
	if (matchesGeneratedPathRule(filePath, config)) {
		return true;
	}

	if (config.contentMarkers.length === 0) {
		return false;
	}

	try {
		const content = await readFile(path.join(repoPath, filePath), 'utf8');
		const normalizedContent = content.toLowerCase();
		return config.contentMarkers.some(marker =>
			normalizedContent.includes(marker.toLowerCase()),
		);
	} catch {
		return false;
	}
}

function matchesGeneratedPathRule(
	filePath: string,
	config: GeneratedFileConfig,
): boolean {
	const normalizedPath = filePath.replaceAll('\\', '/').toLowerCase();
	const pathParts = normalizedPath.split('/');
	const filename = path.basename(normalizedPath);

	return (
		pathParts.some(part =>
			config.ignoredPaths.some(
				ignoredPath => part === ignoredPath.toLowerCase(),
			),
		) ||
		config.ignoredPatterns.some(pattern => {
			const normalizedPattern = pattern.toLowerCase();
			return (
				filename.includes(normalizedPattern) ||
				normalizedPath.includes(normalizedPattern)
			);
		})
	);
}
