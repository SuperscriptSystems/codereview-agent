import { logger } from '../core/logger.js';
import { getTaskIdFromGitInfo } from '../git/context.js';
import { buildJiraDetailsText, getTaskDetails, projectKeys } from './jira.js';

export async function buildJiraContext(
	repoPath: string,
	commitMessages: string,
): Promise<string> {
	if (!process.env.JIRA_URL) {
		return '';
	}

	try {
		const taskId =
			process.env.JIRA_TASK_ID ??
			(await getTaskIdFromGitInfo(repoPath, commitMessages));
		if (!taskId) {
			logger.info(
				'No Jira task ID found; review will continue without Jira context.',
			);
			return '';
		}

		const knownPrefixes = await projectKeys();
		if (knownPrefixes.size > 0) {
			const prefix = taskId.split('-')[0];
			if (!knownPrefixes.has(prefix)) {
				logger.warn(
					`Extracted task '${taskId}' has unknown project prefix '${prefix}'; review will continue without Jira context.`,
				);
				return '';
			}
		}

		const taskDetails = await getTaskDetails(taskId);
		if (!taskDetails) {
			logger.warn(
				`Could not fetch Jira details for ${taskId}; review will continue without Jira context.`,
			);
			return '';
		}

		return buildJiraDetailsText(taskId, taskDetails);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`Failed to build Jira review context: ${message}`);
		return '';
	}
}
