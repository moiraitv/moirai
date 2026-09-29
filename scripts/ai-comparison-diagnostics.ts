import { chmod, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Private artifacts from one comparison request, without authorization headers. */
export interface DiagnosticRequest {
	phase: string;
	startedAt: string;
	endpoint: string;
	body: string;
}

/** Safe timing and provider status extracted from private raw captures. */
export interface DiagnosticPhase {
	phase: string;
	durationMs: number;
	status: number | null;
	provider?: string;
	error?: string;
}

/** Summarize each completed or failed request without copying provider text into reports. */
export async function diagnosticPhases(directory: string): Promise<DiagnosticPhase[]> {
	const files = (await readdir(directory)).filter(name => /^(response|error)-\d+\.json$/u.test(name))
		.sort((left, right) => Number(left.match(/\d+/u)?.[0]) - Number(right.match(/\d+/u)?.[0]));
	const phases: DiagnosticPhase[] = [];
	for (const name of files) {
		const value = JSON.parse(await readFile(join(directory, name), 'utf8')) as {
			phase: string; durationMs: number; status: number | null; error?: string; raw?: string;
		};
		let provider: string | undefined;
		if (value.raw) {
			try {
				const payload = JSON.parse(value.raw) as { provider?: unknown; choices?: Array<{ error?: { metadata?: { provider?: unknown } } }> };
				const reported = payload.provider ?? payload.choices?.[0]?.error?.metadata?.provider;
				provider = typeof reported === 'string' && reported.length <= 100 ? reported : undefined;
			}
			catch {
				// Invalid provider JSON is retained in the private capture for inspection.
			}
		}
		phases.push({ phase: value.phase, durationMs: value.durationMs, status: value.status,
			...(provider ? { provider } : {}), ...(value.error ? { error: value.error } : {}) });
	}
	return phases;
}

/** Create a distinct run directory beside the external comparison configuration. */
export async function createDiagnosticDirectory(configPath: string): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
	const directory = await mkdtemp(join(dirname(configPath), `ai-diagnostics-${timestamp}-`));
	await chmod(directory, 0o700);
	return directory;
}

/** Store a JSON artifact with private permissions, refusing to replace prior evidence. */
export async function writeDiagnosticJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/** Capture exact request and response text, with configured credentials redacted. */
export function diagnosticFetch(directory: string, credentials: string[], phase: () => string, fetchImpl: typeof fetch = fetch): typeof fetch {
	let sequence = 0;
	const redact = (value: string): string => credentials.reduce((text, credential) =>
		credential ? text.replaceAll(credential, '[REDACTED]') : text, value);
	return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		sequence += 1;
		const number = String(sequence).padStart(3, '0');
		const startedAt = new Date().toISOString();
		const started = Date.now();
		const request: DiagnosticRequest = { phase: phase(), startedAt,
			endpoint: new URL(String(input)).pathname, body: redact(String(init?.body ?? '')) };
		await writeDiagnosticJson(join(directory, `request-${number}.json`), request);

		let response: Response | undefined;
		try {
			response = await fetchImpl(input, init);
			const raw = redact(await response.clone().text());
			let usage: unknown = null;
			try {
				const payload = JSON.parse(raw) as { usage?: unknown };
				usage = payload.usage ?? null;
			}
			catch {
				// Preserve malformed responses verbatim for later inspection.
			}
			await writeDiagnosticJson(join(directory, `response-${number}.json`), {
				phase: request.phase, startedAt, durationMs: Date.now() - started,
				status: response.status, usage, raw,
			});
			return response;
		}
		catch (cause) {
			const code = cause instanceof Error && cause.cause && typeof (cause.cause as { code?: unknown }).code === 'string'
				? (cause.cause as { code: string }).code : null;
			await writeDiagnosticJson(join(directory, `error-${number}.json`), {
				phase: request.phase, startedAt, durationMs: Date.now() - started,
				status: response?.status ?? null,
				error: cause instanceof Error ? cause.name : 'UnknownError',
				code: code && /^[A-Z0-9_]+$/u.test(code) ? code : null,
			});
			throw cause;
		}
	}) as typeof fetch;
}
