import type { LogEntry } from '@moirai/shared';

/** Request fields extracted from a structured server log. */
export interface LogRequestDetails {
	method: string | null;
	endpoint: string | null;
	sourceIp: string | null;
}

/** Completion data paired with one incoming Fastify request log. */
export interface LogRequestCompletion {
	entry: LogEntry;
	durationMs: number | null;
	statusCode: number | null;
}

/** One visible log record, optionally enriched by its request completion. */
export interface CondensedLogEntry {
	entry: LogEntry;
	completion: LogRequestCompletion | null;
}

/** Treat plain objects as readable structured context. */
function objectValue(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}

	return value as Record<string, unknown>;
}

/** Read and bound one textual context field. */
function textValue(value: unknown, maximum: number): string | null {
	if (typeof value !== 'string' || !value.trim()) {
		return null;
	}

	return value.trim().slice(0, maximum);
}

/** Remove query and fragment values from a request URL to produce an endpoint label. */
function endpointValue(value: unknown): string | null {
	const raw = textValue(value, 4_096);
	if (!raw) {
		return null;
	}

	try {
		if (/^https?:\/\//i.test(raw)) {
			return new URL(raw).pathname || '/';
		}
	}
	catch {
		// Fall through to the safe relative-path treatment.
	}
	return raw.split(/[?#]/, 1)[0] || '/';
}

/** Extract normalized request information from Fastify or application log context. */
export function logRequestDetails(context: Record<string, unknown>): LogRequestDetails {
	const nestedRequest = objectValue(context.req) ?? objectValue(context.request);
	const source = nestedRequest ?? context;
	const method = textValue(source.method, 16)?.toUpperCase() ?? null;
	const endpoint = endpointValue(source.url ?? source.path ?? source.route);
	const sourceIp = textValue(
		source.remoteAddress ?? source.ip ?? context.remoteAddress ?? context.ip,
		256,
	);
	return { method, endpoint, sourceIp };
}

/** Read a finite non-negative number from structured context. */
function nonNegativeNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read the HTTP status code recorded by Fastify's response serializer. */
function responseStatus(context: Record<string, unknown>): number | null {
	const response = objectValue(context.res) ?? objectValue(context.response);
	const value = nonNegativeNumber(response?.statusCode ?? context.statusCode);
	return value !== null && Number.isInteger(value) && value <= 999 ? value : null;
}

/** Identify Fastify's stable incoming-request record. */
function isIncomingRequest(entry: LogEntry): boolean {
	return entry.message === 'incoming request' && Boolean(entry.requestId);
}

/** Identify Fastify's stable completed-request record. */
function isCompletedRequest(entry: LogEntry): boolean {
	return entry.message === 'request completed' && Boolean(entry.requestId);
}

/** Find the nearest unused incoming request that agrees with a completion timestamp. */
function matchingIncomingRequest(
	completion: LogEntry,
	candidates: LogEntry[],
	pairedIncoming: Set<string>,
): LogEntry | undefined {
	const finish = new Date(completion.time).getTime();
	const recordedDuration = nonNegativeNumber(completion.context.responseTime);
	const expectedStart = recordedDuration === null ? finish : finish - recordedDuration;
	const available = candidates
		.filter((entry) => !pairedIncoming.has(entry.id) && new Date(entry.time).getTime() <= finish)
		.sort(
			(left, right) =>
				Math.abs(new Date(left.time).getTime() - expectedStart)
				- Math.abs(new Date(right.time).getTime() - expectedStart),
		);
	const match = available[0];
	if (!match || recordedDuration === null) {
		return match;
	}

	return Math.abs(new Date(match.time).getTime() - expectedStart) <= 1_000 ? match : undefined;
}

/** Build completion data, falling back to paired timestamps when responseTime is absent. */
function requestCompletion(entry: LogEntry, incoming?: LogEntry): LogRequestCompletion {
	const recordedDuration = nonNegativeNumber(entry.context.responseTime);
	const elapsed = incoming
		? Math.max(0, new Date(entry.time).getTime() - new Date(incoming.time).getTime())
		: null;
	return {
		entry,
		durationMs: recordedDuration ?? elapsed,
		statusCode: responseStatus(entry.context),
	};
}

/** Collapse completed Fastify requests into their corresponding incoming request rows. */
export function condenseRequestLogs(entries: LogEntry[]): CondensedLogEntry[] {
	const incomingByRequest = new Map<string, LogEntry[]>();
	for (const entry of entries) {
		if (isIncomingRequest(entry)) {
			const candidates = incomingByRequest.get(entry.requestId!) ?? [];
			candidates.push(entry);
			incomingByRequest.set(entry.requestId!, candidates);
		}
	}
	const incomingForCompletion = new Map<string, LogEntry>();
	const pairedIncoming = new Set<string>();
	for (const entry of entries) {
		if (!isCompletedRequest(entry)) {
			continue;
		}

		const incoming = matchingIncomingRequest(
			entry,
			incomingByRequest.get(entry.requestId!) ?? [],
			pairedIncoming,
		);
		if (incoming) {
			incomingForCompletion.set(entry.id, incoming);
			pairedIncoming.add(incoming.id);
		}
	}

	const result: CondensedLogEntry[] = [];
	for (const entry of entries) {
		if (isCompletedRequest(entry)) {
			const incoming = incomingForCompletion.get(entry.id);
			result.push({
				entry: incoming ?? entry,
				completion: requestCompletion(entry, incoming),
			});
			continue;
		}

		if (isIncomingRequest(entry) && pairedIncoming.has(entry.id)) {
			continue;
		}

		result.push({ entry, completion: null });
	}
	return result;
}
