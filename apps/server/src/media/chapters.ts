import { MAX_MID_ROLL_POINTS, type MediaChapter } from '@moirai/shared';

/** Report a chapter list longer than the break points scheduling can place. */
export function chapterInputExceedsLimit(value: unknown): boolean {
	return Array.isArray(value) && value.length > MAX_MID_ROLL_POINTS;
}

/** Normalize bounded chapter facts without using chapter gaps to remove source content. */
export function normalizeMediaChapters(value: unknown, durationSeconds: number): MediaChapter[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const result = value.slice(0, MAX_MID_ROLL_POINTS).flatMap((chapter): MediaChapter[] => {
		if (!chapter || typeof chapter !== 'object') {
			return [];
		}
		if (!['number', 'string'].includes(typeof chapter.startSeconds) || !['number', 'string'].includes(typeof chapter.finishSeconds)) {
			return [];
		}
		const start = Number(chapter.startSeconds);
		const finish = Number(chapter.finishSeconds);
		if (!Number.isFinite(start) || !Number.isFinite(finish) || start < 0
			|| start >= durationSeconds || finish <= start) {
			return [];
		}
		return [{ startSeconds: Math.round(start * 1_000) / 1_000,
			finishSeconds: Math.round(Math.min(finish, durationSeconds) * 1_000) / 1_000,
			title: typeof chapter.title === 'string' ? chapter.title.trim().slice(0, 512) : '' }];
	});
	return result.filter(chapter => chapter.finishSeconds > chapter.startSeconds).sort((left, right) => left.startSeconds - right.startSeconds || left.finishSeconds - right.finishSeconds);
}
