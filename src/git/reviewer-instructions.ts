import { execa } from 'execa';

export const reviewerInstructionsFileName = 'reviewer-instructions.md';
export const maxReviewerInstructionsBytes = 64 * 1024;

export async function getReviewerInstructions(
	repoPath: string,
	ref: string,
): Promise<string | undefined> {
	const treeEntry = await execa(
		'git',
		['ls-tree', ref, '--', reviewerInstructionsFileName],
		{ cwd: repoPath },
	);
	const entry = treeEntry.stdout.trim();

	if (!entry) {
		return undefined;
	}

	const match = entry.match(/^(\d{6})\s+(\S+)\s+[0-9a-f]+\t/);
	if (!match || !match[1]?.startsWith('100') || match[2] !== 'blob') {
		throw new Error(
			`${reviewerInstructionsFileName} at ${ref} must be a regular file, not a symlink, directory, or submodule.`,
		);
	}

	const objectSpec = `${ref}:${reviewerInstructionsFileName}`;
	const sizeResult = await execa('git', ['cat-file', '-s', objectSpec], {
		cwd: repoPath,
	});
	const size = Number.parseInt(sizeResult.stdout.trim(), 10);

	if (!Number.isFinite(size)) {
		throw new Error(
			`Could not determine the size of ${reviewerInstructionsFileName} at ${ref}.`,
		);
	}

	if (size > maxReviewerInstructionsBytes) {
		throw new Error(
			`${reviewerInstructionsFileName} at ${ref} is ${size} bytes; the maximum is ${maxReviewerInstructionsBytes} bytes.`,
		);
	}

	const contentResult = await execa('git', ['show', objectSpec], {
		cwd: repoPath,
	});
	return contentResult.stdout.trim() ? contentResult.stdout : undefined;
}
