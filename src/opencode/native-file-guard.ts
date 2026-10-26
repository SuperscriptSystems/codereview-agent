import { realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FilteringConfig } from '../core/models.js';
import { isTestFile, shouldIgnorePath } from '../git/filtering.js';

export const nativeReviewTools = {
	'*': false,
	read: true,
	glob: true,
	grep: true,
	StructuredOutput: true,
};

export interface NativeFileGuardOptions {
	testKeywords: string[];
	filtering: FilteringConfig;
}

type ToolInput = { tool: string; args?: Record<string, unknown> };
type ToolOutput = {
	output: string;
	metadata: Record<string, unknown>;
	attachments?: unknown[];
};

/** Keep OpenCode's native tools and context; filter their inputs and model-visible results. */
export async function createNativeFileGuard(
	repoPath: string,
	options: NativeFileGuardOptions,
) {
	const root = await realpath(repoPath);
	const sourceRoot = path.resolve(repoPath);
	async function permitted(file: string): Promise<boolean> {
		const absolute = path.resolve(root, file);
		const relative =
			absolute === sourceRoot || absolute.startsWith(`${sourceRoot}${path.sep}`)
				? path.relative(sourceRoot, absolute)
				: path.relative(root, absolute);
		if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
		if (relative.split(path.sep).includes('.git')) return false;
		if (
			isTestFile(relative, options.testKeywords) ||
			shouldIgnorePath(relative, options.filtering)
		)
			return false;
		try {
			const canonical = await realpath(absolute);
			const resolved = path.relative(root, canonical);
			return (
				!resolved.startsWith('..') &&
				!path.isAbsolute(resolved) &&
				!resolved.split(path.sep).includes('.git') &&
				!isTestFile(resolved, options.testKeywords) &&
				!shouldIgnorePath(resolved, options.filtering)
			);
		} catch {
			return false;
		}
	}
	return {
		async 'tool.execute.before'(
			input: ToolInput,
			output: { args: Record<string, unknown> },
		) {
			if (
				!Object.hasOwn(nativeReviewTools, input.tool) ||
				!nativeReviewTools[input.tool as keyof typeof nativeReviewTools]
			) {
				throw new Error(
					'Only native read, glob and grep are allowed for review context.',
				);
			}
			if (!['read', 'glob', 'grep'].includes(input.tool)) return;
			const requested =
				output.args[input.tool === 'read' ? 'filePath' : 'path'];
			const file = typeof requested === 'string' ? requested : root;
			if (!(await permitted(file)))
				throw new Error(
					'Test, ignored and external paths are excluded from review context.',
				);
		},
		async 'tool.execute.after'(input: ToolInput, output: ToolOutput) {
			if (input.tool === 'grep') {
				const sections: string[] = [];
				let keep = false;
				let matches = 0;
				for (const line of output.output.split('\n')) {
					if (path.isAbsolute(line) && line.endsWith(':')) {
						keep = await permitted(line.slice(0, -1));
						if (keep) sections.push(line);
					} else if (keep && /^  Line \d+:/.test(line)) {
						sections.push(line);
						matches++;
					}
				}
				output.output = matches
					? `Found ${matches} application-code matches\n${sections.join('\n')}`
					: 'No application-code matches found. Narrow the path or pattern if results were truncated.';
				output.metadata = {
					matches,
					truncated: Boolean(output.metadata.truncated),
				};
				output.attachments = [];
			}
			if (input.tool === 'glob') {
				const files: string[] = [];
				for (const line of output.output.split('\n')) {
					if (path.isAbsolute(line) && (await permitted(line)))
						files.push(line);
				}
				output.output = files.join('\n') || 'No application files found';
				output.metadata = {
					count: files.length,
					truncated: Boolean(output.metadata.truncated),
				};
				output.attachments = [];
			}
			if (input.tool === 'read') {
				const requested = input.args?.filePath;
				if (typeof requested !== 'string' || !(await permitted(requested)))
					throw new Error('Excluded context file.');
				const absolute = path.resolve(root, requested);
				if ((await stat(absolute)).isDirectory()) {
					const entries: string[] = [];
					for (const entry of await readdir(absolute, {
						withFileTypes: true,
					})) {
						if (await permitted(path.join(absolute, entry.name)))
							entries.push(`${entry.name}${entry.isDirectory() ? '/' : ''}`);
					}
					output.output = `<path>${absolute}</path>\n<type>directory</type>\n<entries>\n${entries.slice(0, 500).join('\n')}\n</entries>`;
					output.metadata = {};
					output.attachments = [];
				}
			}
		},
	};
}
