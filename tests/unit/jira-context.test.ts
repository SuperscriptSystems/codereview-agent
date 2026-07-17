import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getTaskIdFromGitInfoMock = vi.fn();
const projectKeysMock = vi.fn();
const getTaskDetailsMock = vi.fn();
const buildJiraDetailsTextMock = vi.fn();

vi.mock('../../src/git/context.js', () => ({
	getTaskIdFromGitInfo: getTaskIdFromGitInfoMock,
}));

vi.mock('../../src/integrations/jira.js', () => ({
	projectKeys: projectKeysMock,
	getTaskDetails: getTaskDetailsMock,
	buildJiraDetailsText: buildJiraDetailsTextMock,
}));

vi.mock('../../src/core/logger.js', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

const { buildJiraContext } =
	await import('../../src/integrations/jira-context.js');

describe('Jira review context', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.JIRA_URL = 'https://example.atlassian.net';
		getTaskIdFromGitInfoMock.mockResolvedValue('EX-123');
		projectKeysMock.mockResolvedValue(new Set(['EX']));
		getTaskDetailsMock.mockResolvedValue({
			summary: 'Add export flow',
			description: 'Users can export reports.',
		});
		buildJiraDetailsTextMock.mockReturnValue(
			'--- JIRA TASK CONTEXT (EX-123) ---\nTitle: Add export flow\nDescription:\nUsers can export reports.\n---------------------------------',
		);
	});

	afterEach(() => {
		delete process.env.JIRA_URL;
		delete process.env.JIRA_TASK_ID;
	});

	it('builds review context from existing Jira task details formatter', async () => {
		const context = await buildJiraContext('/repo', 'feat: EX-123 export');

		expect(getTaskIdFromGitInfoMock).toHaveBeenCalledWith(
			'/repo',
			'feat: EX-123 export',
		);
		expect(getTaskDetailsMock).toHaveBeenCalledWith('EX-123');
		expect(buildJiraDetailsTextMock).toHaveBeenCalledWith('EX-123', {
			summary: 'Add export flow',
			description: 'Users can export reports.',
		});
		expect(context).toContain('Title: Add export flow');
		expect(context).toContain('Users can export reports.');
	});

	it('returns empty context when Jira is not configured', async () => {
		delete process.env.JIRA_URL;

		await expect(
			buildJiraContext('/repo', 'feat: EX-123 export'),
		).resolves.toBe('');
		expect(getTaskIdFromGitInfoMock).not.toHaveBeenCalled();
	});

	it('uses explicit JIRA_TASK_ID before git-derived task ids', async () => {
		process.env.JIRA_TASK_ID = 'EX-999';

		await buildJiraContext('/repo', 'feat: EX-123 export');

		expect(getTaskIdFromGitInfoMock).not.toHaveBeenCalled();
		expect(getTaskDetailsMock).toHaveBeenCalledWith('EX-999');
	});
});
