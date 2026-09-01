import { createHash } from 'node:crypto';

/** Serialize a JSON-compatible value with stable object-key ordering. */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(',')}]`;
	}

	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
			left.localeCompare(right));

		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
	}

	return JSON.stringify(value);
}

/** Create a repeatable SHA-256 identity for a JSON-compatible value. */
export function stableJsonFingerprint(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}
