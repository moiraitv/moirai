import { liveEvents } from '../../live-events';

/** Reload selected cards after a completed programming-affecting scan of their library. */
export function subscribeToSelectedMediaRefresh(
	libraryId: () => string,
	enabled: () => boolean,
	refresh: () => void,
): () => void {
	return liveEvents.subscribe((event) => {
		if (
			event.type === 'scan.changed'
			&& event.data.libraryId === libraryId()
			&& event.data.affectsProgramming
			&& (event.data.status === 'complete' || event.data.status === 'partial')
			&& enabled()
		) {
			refresh();
		}
	});
}
