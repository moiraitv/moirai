import { EventEmitter } from 'node:events';
import { watch } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchDocumentation } from '@scripts/dev-docs.mjs';

vi.mock('node:fs', () => ({ watch: vi.fn() }));

describe('development guide builds', () => {
	let inputs;
	let documentation;

	beforeEach(() => {
		vi.useFakeTimers();
		inputs = new Map();
		vi.mocked(watch).mockImplementation((root, _options, callback) => {
			const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
			inputs.set(path.relative('/project', root), { callback, watcher });
			return watcher;
		});
	});

	afterEach(async () => {
		await documentation?.close();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('builds initially and watches authored pages, assets, theme, reviews, and helpers', async () => {
		const rebuild = vi.fn().mockResolvedValue(undefined);
		documentation = watchDocumentation('/project', rebuild);
		await documentation.ready;
		expect(rebuild).toHaveBeenCalledTimes(1);

		for (const [root, filename] of [
			['apps/docs', 'src/playback/graphics.md'],
			['apps/docs', 'src/public/screenshots/graphics.png'],
			['apps/docs', '.vitepress/theme/theme.scss'],
			['apps/docs', 'reviews.json'],
			['scripts', 'user-docs-highlights.ts'],
			['', 'package.json'],
			['apps/web/src', 'help.ts'],
		]) {
			inputs.get(root).callback('change', filename);
		}
		await vi.advanceTimersByTimeAsync(200);
		expect(rebuild).toHaveBeenCalledTimes(2);
	});

	it('ignores build outputs and generated review files', async () => {
		const rebuild = vi.fn().mockResolvedValue(undefined);
		documentation = watchDocumentation('/project', rebuild);
		await documentation.ready;
		for (const filename of [
			'dist/playback/graphics.html',
			'.vitepress/cache/deps/vue.js',
			'.vitepress/.temp/app.js',
			'src/review.md',
			'src/public/contextual-help.json',
			'src/public/review-assets/before.png',
		]) {
			inputs.get('apps/docs').callback('change', filename);
		}
		inputs.get('scripts').callback('change', 'dev.mjs');
		inputs.get('apps/web/src').callback('change', 'App.vue');
		await vi.advanceTimersByTimeAsync(1_000);
		expect(rebuild).toHaveBeenCalledTimes(1);
	});

	it('serializes changes during a build into one follow-up build', async () => {
		let finish;
		const rebuild = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
			finish = resolve;
		}));
		documentation = watchDocumentation('/project', rebuild);
		await Promise.resolve();
		inputs.get('apps/docs').callback('change', 'src/index.md');
		await vi.advanceTimersByTimeAsync(200);
		inputs.get('apps/docs').callback('change', 'src/glossary.md');
		await vi.advanceTimersByTimeAsync(200);
		expect(rebuild).toHaveBeenCalledTimes(1);

		finish();
		await documentation.ready;
		await vi.advanceTimersByTimeAsync(200);
		expect(rebuild).toHaveBeenCalledTimes(2);
	});

	it('reports a failure and recovers on the next edit', async () => {
		const error = new Error('Invalid guide link');
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const rebuild = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
		documentation = watchDocumentation('/project', rebuild);
		await documentation.ready;
		expect(log).toHaveBeenCalledWith(expect.stringContaining('Guide build failed'), error);
		inputs.get('apps/docs').callback('change', 'src/index.md');
		await vi.advanceTimersByTimeAsync(200);
		expect(rebuild).toHaveBeenCalledTimes(2);
	});

	it('closes watchers and cancels a queued rebuild on shutdown', async () => {
		const rebuild = vi.fn().mockResolvedValue(undefined);
		documentation = watchDocumentation('/project', rebuild);
		await documentation.ready;
		inputs.get('apps/docs').callback('change', 'src/index.md');
		await documentation.close();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(rebuild).toHaveBeenCalledTimes(1);
		for (const { watcher } of inputs.values()) {
			expect(watcher.close).toHaveBeenCalled();
		}
	});
});
