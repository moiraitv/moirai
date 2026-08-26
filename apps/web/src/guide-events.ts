import type { LiveEvent } from '@moirai/shared';

/** Identify events after which guide consumers must recover authoritative REST state. */
export function affectsGuide(event: LiveEvent): boolean {
	return (
		event.type === 'system.ready'
		|| event.type === 'channel.changed'
		|| event.type === 'scheduling.changed'
		|| event.type === 'timeline.changed'
		|| (event.type === 'scan.changed' && event.data.affectsProgramming)
	);
}
