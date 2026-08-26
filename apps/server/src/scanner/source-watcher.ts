import type { FSWatcher as ChokidarWatcher } from 'chokidar';
import { watch as watchWithChokidar } from 'chokidar';
import type { SourceWatcher, SourceWatcherCallbacks } from './contracts.js';

/** Minimal dynamic FSEvents API used only on macOS. */
interface FSEventsApi {
	watch(path: string, handler: (path: string, flags: number, id: string) => void): () => Promise<void> | void;
}

/** Wrap a Chokidar watcher in the common close contract. */
function chokidarSourceWatcher(watcher: ChokidarWatcher): SourceWatcher {
	return { close: () => watcher.close() };
}

/** Create a recursive watcher without requiring one file descriptor per directory on macOS. */
export async function createSourceWatcher(
	root: string,
	callbacks: SourceWatcherCallbacks,
): Promise<SourceWatcher> {
	if (process.platform === 'darwin') {
		const imported = await import('fsevents') as unknown as { default?: FSEventsApi } & FSEventsApi;
		const fsevents = imported.default ?? imported;
		const stop = fsevents.watch(root, () => callbacks.onChange());
		return {
			async close(): Promise<void> {
				await stop();
			},
		};
	}

	const watcher = watchWithChokidar(root, {
		ignoreInitial: true,
		persistent: true,
		followSymlinks: false,
		awaitWriteFinish: { stabilityThreshold: 1_500, pollInterval: 100 },
	});
	watcher.on('error', callbacks.onError);
	watcher.on('all', callbacks.onChange);
	return chokidarSourceWatcher(watcher);
}
