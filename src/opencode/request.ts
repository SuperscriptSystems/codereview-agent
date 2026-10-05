import { logger } from '../core/logger.js';

export const requestTimeoutMs = 15_000;
const retryAttempts = 3;
const retryDelayMs = 500;

export interface RequestDiagnostics {
	label: string;
	getRecentServerOutput?: () => string;
	quiet?: boolean;
	signal?: AbortSignal;
}

export interface RequestOptions extends RequestDiagnostics {
	timeoutMs?: number;
	retry?: boolean;
}

export async function runRequest<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	options: RequestOptions,
): Promise<T> {
	const controller = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
	const timer = setTimeout(() => {
		controller.abort(
			new Error(`${options.label} timed out after ${timeoutMs}ms.`),
		);
	}, timeoutMs);
	let onAbort: (() => void) | undefined;
	try {
		signal.throwIfAborted();
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal.reason);
			signal.addEventListener('abort', onAbort, { once: true });
		});
		return await Promise.race([
			withTransportRetry(
				() => operation(signal),
				{ ...options, signal },
				options.retry === false ? 1 : retryAttempts,
			),
			cancelled,
		]);
	} catch (error) {
		if (signal.aborted && !options.signal?.aborted) {
			logger.warn(`${options.label}: ${formatTransportError(signal.reason)}`);
			logServerOutput(options);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		if (onAbort) signal.removeEventListener('abort', onAbort);
	}
}

export async function withTransportRetry<T>(
	operation: () => Promise<T>,
	diagnostics?: RequestDiagnostics,
	attempts = retryAttempts,
): Promise<T> {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		diagnostics?.signal?.throwIfAborted();
		const startedAt = Date.now();
		if (diagnostics && !diagnostics.quiet) {
			logger.info(
				`${diagnostics.label} attempt ${attempt}/${attempts} started at ${new Date(startedAt).toISOString()}.`,
			);
		}
		try {
			const result = await operation();
			diagnostics?.signal?.throwIfAborted();
			if (diagnostics && !diagnostics.quiet) {
				logger.info(
					`${diagnostics.label} attempt ${attempt}/${attempts} completed in ${Date.now() - startedAt}ms.`,
				);
			}
			return result;
		} catch (error) {
			diagnostics?.signal?.throwIfAborted();
			if (diagnostics) {
				logger.warn(
					`${diagnostics.label} attempt ${attempt}/${attempts} failed after ${Date.now() - startedAt}ms: ${formatTransportError(error)}.`,
				);
				logServerOutput(diagnostics);
			}
			if (!isRetryableTransportError(error) || attempt === attempts)
				throw error;
			logger.warn(
				`OpenCode transport attempt ${attempt}/${attempts} failed after ${Date.now() - startedAt}ms: ${formatTransportError(error)}. Retrying in ${retryDelayMs * attempt}ms.`,
			);
			await waitForDelay(retryDelayMs * attempt, diagnostics?.signal);
		}
	}
	throw new Error('OpenCode request exhausted its retry attempts.');
}

export function waitForDelay(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export function isRetryableTransportError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes('fetch failed') ||
		message.includes('ECONNRESET') ||
		message.includes('socket hang up')
	);
}

function logServerOutput(options: RequestDiagnostics): void {
	const output = formatRecentServerOutput(
		options.getRecentServerOutput?.() ?? '',
	);
	if (output) logger.warn(`${options.label} recent server output:\n${output}`);
}

export function formatRecentServerOutput(output: string): string {
	return redactSecrets(output).slice(-8000).trim();
}

export function formatTransportError(error: unknown): string {
	const details: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 3 && current; depth += 1) {
		if (!(current instanceof Error)) {
			if (depth === 0) details.push(String(current));
			break;
		}
		const code = (current as Error & { code?: unknown }).code;
		const name = current.name !== 'Error' ? `${current.name}: ` : '';
		details.push(
			`${name}${current.message}${typeof code === 'string' ? ` (code: ${code})` : ''}`,
		);
		current = current.cause;
	}
	return redactSecrets(details.join(' <- caused by ')).slice(0, 800);
}

function redactSecrets(output: string): string {
	const secrets = Object.entries(process.env)
		.filter(
			([name, value]) =>
				/(?:KEY|TOKEN|PASSWORD|SECRET|AUTH)/i.test(name) &&
				value &&
				value.length >= 6,
		)
		.map(([, value]) => value as string);
	for (const secret of secrets)
		output = output.replaceAll(secret, '[REDACTED]');
	return output;
}
