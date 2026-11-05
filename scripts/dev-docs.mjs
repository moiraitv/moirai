import { watch } from 'node:fs';
import path from 'node:path';

/** Debounce clustered editor writes before rebuilding the bundled guide. */
const rebuildDelayMs = 200;

/** Watch authored guide inputs and serialize builds without watching generated output. */
export function watchDocumentation(repositoryRoot, rebuild) {
	let closed = false;
	let dirty = false;
	let timer;
	let active;

	/** Coalesce changes during a build into one follow-up build, including after a failure. */
	function build() {
		if (closed || active) {
			return active;
		}

		dirty = false;
		active = Promise.resolve().then(rebuild).catch((error) => {
			if (!closed) {
				console.error('[dev] Guide build failed; waiting for a documentation change.', error);
			}
		}).finally(() => {
			active = undefined;
			if (dirty && !closed) {
				schedule();
			}
		});
		return active;
	}

	/** Delay a rebuild until clustered changes settle without interrupting an active build. */
	function schedule() {
		if (closed) {
			return;
		}

		dirty = true;
		clearTimeout(timer);
		timer = setTimeout(build, rebuildDelayMs);
	}

	const inputs = [
		['apps/docs', true, (name) => !/^(?:dist|node_modules|\.vitepress\/(?:cache|\.temp))(?:\/|$)/u.test(name)
			&& !/^src\/(?:review\.md$|public\/(?:contextual-help\.json$|review-assets(?:\/|$)))/u.test(name)],
		['scripts', false, (name) => /^user-docs.*\.ts$/u.test(name)],
		['.', false, (name) => name === 'package.json'],
		['apps/web/src', false, (name) => /^help(?:-review)?\.ts$/u.test(name)],
	];
	const watchers = inputs.map(([relativeRoot, recursive, accepts]) => {
		const root = path.join(repositoryRoot, relativeRoot);
		const watcher = watch(root, { recursive }, (_event, filename) => {
			if (!filename || accepts(filename.toString().split(path.sep).join('/'))) {
				schedule();
			}
		});
		watcher.on('error', (error) => {
			console.warn(`[dev] Guide watching is unavailable for ${relativeRoot}; restart after edits.`, error);
		});
		return watcher;
	});

	return {
		ready: build(),
		/** Stop observing edits and cancel queued work while the caller stops any active builder. */
		close() {
			closed = true;
			clearTimeout(timer);
			watchers.forEach((watcher) => watcher.close());
			return active;
		},
	};
}
