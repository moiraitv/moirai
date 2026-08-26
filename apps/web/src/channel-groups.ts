import type { Channel } from '@moirai/shared';

/** Channel paired with guide segments for prefix-based visual grouping. */
export type ChannelGuideRow
	= | { type: 'family'; key: string; label: string }
		| { type: 'channel'; key: string; channel: Channel };

/** Sort channel numbers naturally and label dotted families only when at least two exist. */
export function channelGuideRows(channels: Channel[]): ChannelGuideRow[] {
	const sorted = [...channels].sort((left, right) =>
		left.number.localeCompare(right.number, undefined, { numeric: true, sensitivity: 'base' }));
	const familyCounts = new Map<string, number>();
	for (const channel of sorted) {
		const separator = channel.number.indexOf('.');
		if (separator > 0) {
			const prefix = channel.number.slice(0, separator);
			familyCounts.set(prefix, (familyCounts.get(prefix) ?? 0) + 1);
		}
	}
	const rows: ChannelGuideRow[] = [];
	let priorFamily: string | null = null;
	for (const channel of sorted) {
		const separator = channel.number.indexOf('.');
		const family = separator > 0 ? channel.number.slice(0, separator) : null;
		if (family && (familyCounts.get(family) ?? 0) > 1 && family !== priorFamily) {
			rows.push({ type: 'family', key: `family:${family}`, label: `${family} channels` });
		}
		rows.push({ type: 'channel', key: channel.id, channel });
		priorFamily = family && (familyCounts.get(family) ?? 0) > 1 ? family : null;
	}
	return rows;
}
