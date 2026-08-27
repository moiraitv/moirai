/** Format elapsed seconds as rounded minutes while carrying complete hours correctly. */
export function compactDurationLabel(seconds: number | null, unavailableLabel: string): string {
	if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
		return unavailableLabel;
	}

	const totalMinutes = Math.max(1, Math.round(seconds / 60));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : ''].filter(Boolean).join(' ');
}
