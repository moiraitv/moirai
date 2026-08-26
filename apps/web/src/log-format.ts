/** Presentation density used for request-duration labels. */
export type RequestDurationStyle = 'compact' | 'detail';

/** Format a request duration with the precision expected by its log presentation. */
export function requestDurationLabel(
	value: number | null,
	style: RequestDurationStyle,
): string {
	if (value === null) {
		return style === 'compact' ? '—' : 'Unavailable';
	}

	if (style === 'compact') {
		if (value < 1) {
			return `${value.toFixed(2)} ms`;
		}

		if (value < 1_000) {
			return `${value.toFixed(1)} ms`;
		}

		return `${(value / 1_000).toFixed(2)} s`;
	}

	if (value < 1_000) {
		return `${value.toFixed(2)} ms`;
	}

	return `${(value / 1_000).toFixed(3)} seconds`;
}
