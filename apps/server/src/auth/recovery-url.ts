import process from 'node:process';
import type { AppConfig } from '../config.js';

/** Deadline for detecting a Vite server without delaying production recovery output materially. */
const DEVELOPMENT_MANAGEMENT_PROBE_TIMEOUT_MS = 1_000;
/** Maximum Vite client script inspected while distinguishing it from another local HTTP service. */
const DEVELOPMENT_MANAGEMENT_PROBE_MAX_BYTES = 64 * 1_024;

/** Recognize a bounded Vite client response before directing a recovery fragment to its origin. */
async function isViteClientResponse(response: Response): Promise<boolean> {
	if (!response.ok || !response.headers.get('content-type')?.includes('javascript')) {
		return false;
	}

	const reader = response.body?.getReader();
	if (!reader) {
		return false;
	}
	const decoder = new TextDecoder();
	let script = '';
	let receivedBytes = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}

		receivedBytes += chunk.value.byteLength;
		if (receivedBytes > DEVELOPMENT_MANAGEMENT_PROBE_MAX_BYTES) {
			await reader.cancel();
			return false;
		}
		script += decoder.decode(chunk.value, { stream: true });
	}
	script += decoder.decode();
	return script.includes('import "@vite/env"')
		&& script.includes('vite:beforeUpdate')
		&& script.includes('createHotContext');
}

/**
 * Resolve the browser origin used by the recovery command. Explicit configuration always wins;
 * otherwise an active Vite client endpoint selects the conventional development port.
 */
export async function recoveryManagementUrl(
	config: AppConfig,
	environment: NodeJS.ProcessEnv = process.env,
	probe: typeof fetch = fetch,
): Promise<string> {
	if (Object.hasOwn(environment, 'MOIRAI_MANAGEMENT_URL')) {
		return config.managementUrl;
	}

	const candidate = new URL(config.publicUrl);
	// MOIRAI_WEB_PORT identifies only the optional Vite development server.
	candidate.port = environment.MOIRAI_WEB_PORT?.trim() || '5173';
	try {
		const response = await probe(new URL('/@vite/client', candidate), {
			cache: 'no-store',
			signal: AbortSignal.timeout(DEVELOPMENT_MANAGEMENT_PROBE_TIMEOUT_MS),
		});
		if (await isViteClientResponse(response)) {
			return candidate.origin;
		}
	}
	catch {
		// A missing development server is expected for production and server-only recovery.
	}

	return config.managementUrl;
}
