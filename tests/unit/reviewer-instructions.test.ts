import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.fn();

vi.mock('execa', () => ({
	execa: execaMock,
}));

const {
	getReviewerInstructions,
	maxReviewerInstructionsBytes,
	reviewerInstructionsFileName,
} = await import('../../src/git/reviewer-instructions.js');

describe('getReviewerInstructions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('reads a regular instruction file from the requested ref', async () => {
		execaMock
			.mockResolvedValueOnce({
				stdout: `100644 blob ${'a'.repeat(40)}\t${reviewerInstructionsFileName}`,
			})
			.mockResolvedValueOnce({ stdout: '42' })
			.mockResolvedValueOnce({
				stdout: '# Review rules\n\n- Check Team isolation.',
			});

		await expect(getReviewerInstructions('/repo', 'origin/main')).resolves.toBe(
			'# Review rules\n\n- Check Team isolation.',
		);
		expect(execaMock).toHaveBeenNthCalledWith(
			1,
			'git',
			['ls-tree', 'origin/main', '--', reviewerInstructionsFileName],
			{ cwd: '/repo' },
		);
		expect(execaMock).toHaveBeenNthCalledWith(
			3,
			'git',
			['show', `origin/main:${reviewerInstructionsFileName}`],
			{ cwd: '/repo' },
		);
	});

	it('returns undefined when the file is absent', async () => {
		execaMock.mockResolvedValueOnce({ stdout: '' });

		await expect(
			getReviewerInstructions('/repo', 'HEAD'),
		).resolves.toBeUndefined();
		expect(execaMock).toHaveBeenCalledTimes(1);
	});

	it('returns undefined when the file is empty', async () => {
		execaMock
			.mockResolvedValueOnce({
				stdout: `100644 blob ${'a'.repeat(40)}\t${reviewerInstructionsFileName}`,
			})
			.mockResolvedValueOnce({ stdout: '0' })
			.mockResolvedValueOnce({ stdout: '' });

		await expect(
			getReviewerInstructions('/repo', 'HEAD'),
		).resolves.toBeUndefined();
	});

	it('rejects symlinks without reading their target', async () => {
		execaMock.mockResolvedValueOnce({
			stdout: `120000 blob ${'a'.repeat(40)}\t${reviewerInstructionsFileName}`,
		});

		await expect(
			getReviewerInstructions('/repo', 'origin/main'),
		).rejects.toThrow('must be a regular file');
		expect(execaMock).toHaveBeenCalledTimes(1);
	});

	it('rejects instruction files over the size limit before reading them', async () => {
		execaMock
			.mockResolvedValueOnce({
				stdout: `100644 blob ${'a'.repeat(40)}\t${reviewerInstructionsFileName}`,
			})
			.mockResolvedValueOnce({
				stdout: String(maxReviewerInstructionsBytes + 1),
			});

		await expect(
			getReviewerInstructions('/repo', 'origin/main'),
		).rejects.toThrow(`the maximum is ${maxReviewerInstructionsBytes} bytes`);
		expect(execaMock).toHaveBeenCalledTimes(2);
	});
});
