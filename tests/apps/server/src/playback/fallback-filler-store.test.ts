import { Readable } from 'node:stream';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rename,
	rm,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_FILLER_MIN_DURATION_MILLISECONDS } from '@moirai/shared';
import type { MediaProbe, MediaProbeResult } from '@server/media/media-probe.js';
import {
	FallbackFillerStore,
	FallbackFillerValidationError,
} from '@server/playback/fallback-filler-store.js';

const roots: string[] = [];

/** Return deterministic probed facts for one test upload. */
function probed(hasAudio: boolean, durationMilliseconds = 90_000): MediaProbeResult {
	return {
		durationMilliseconds,
		fileSizeBytes: 12,
		container: 'mov,mp4,m4a,3gp,3g2,mj2',
		streams: [
			{
				index: 0,
				type: 'video',
				codec: 'h264',
				durationMilliseconds,
				width: 1280,
				height: 720,
				language: null,
				title: null,
				isDefault: true,
				isForced: false,
				isHearingImpaired: false,
				isCommentary: false,
			},
			...(hasAudio
				? [{
					index: 1,
					type: 'audio' as const,
					codec: 'aac',
					durationMilliseconds,
					width: null,
					height: null,
					language: null,
					title: null,
					isDefault: true,
					isForced: false,
					isHearingImpaired: false,
					isCommentary: false,
				}]
				: []),
		],
		resolution: { width: 1280, height: 720 },
		tags: {},
	};
}

/** Build an initialized store around a controllable media probe. */
async function fixture(probe: ReturnType<typeof vi.fn>) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-fallback-store-'));
	roots.push(root);
	const store = new FallbackFillerStore(
		path.join(root, 'managed'),
		path.resolve('apps/server/assets'),
		{ probe } as unknown as MediaProbe,
		{ warn: vi.fn() },
	);
	await store.start([]);
	return { root, store };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('fallback filler store', () => {
	it('resolves channel, global, then bundled precedence from active asset pairs', async () => {
		const probe = vi.fn(async () => probed(false));
		const { root, store } = await fixture(probe);
		const channelId = crypto.randomUUID();

		await store.store({ type: 'global' }, 'global.mp4', Readable.from(Buffer.alloc(12, 1)));
		expect(await store.resolve(channelId)).toMatchObject({ source: 'global', hasAudio: false });
		await store.store(
			{ type: 'channel', channelId },
			'channel.mp4',
			Readable.from(Buffer.alloc(12, 2)),
		);
		expect(await store.resolve(channelId)).toMatchObject({ source: 'channel', hasAudio: false });
		expect(await readdir(path.join(root, 'managed', 'global'))).toEqual(['current']);

		await store.remove({ type: 'channel', channelId });
		expect((await store.resolve(channelId)).source).toBe('global');
		await store.remove({ type: 'global' });
		await expect(access(path.join(root, 'managed', 'global', 'current')))
			.rejects.toMatchObject({ code: 'ENOENT' });
		const bundled = JSON.parse(await readFile('apps/server/assets/dead-air.json', 'utf8'));
		expect(await store.resolve(channelId)).toMatchObject({
			source: 'bundled',
			durationMilliseconds: bundled.durationMilliseconds,
		});
	});

	it('retains a removed asset until inherited playout has synchronized', async () => {
		const probe = vi.fn(async () => probed(false));
		const { root, store } = await fixture(probe);
		const current = path.join(root, 'managed', 'global', 'current');
		await store.store({ type: 'global' }, 'global.mp4', Readable.from(Buffer.alloc(12, 1)));

		await store.remove({ type: 'global' }, async () => {
			await expect(access(current)).resolves.toBeUndefined();
			expect((await store.resolve(crypto.randomUUID())).source).toBe('bundled');
		});

		await expect(access(current)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('allows unrelated channel uploads to proceed independently', async () => {
		let releaseFirstProbe: () => void = () => {};
		let markFirstProbeStarted: () => void = () => {};
		const firstProbeStarted = new Promise<void>((resolve) => {
			markFirstProbeStarted = resolve;
		});
		const firstProbeGate = new Promise<void>((resolve) => {
			releaseFirstProbe = resolve;
		});
		let probeCalls = 0;
		const probe = vi.fn(async () => {
			probeCalls += 1;
			if (probeCalls === 1) {
				markFirstProbeStarted();
				await firstProbeGate;
			}

			return probed(true);
		});
		const { store } = await fixture(probe);
		const first = store.store(
			{ type: 'channel', channelId: crypto.randomUUID() },
			'first.mp4',
			Readable.from(Buffer.alloc(12, 1)),
		);
		await firstProbeStarted;
		const second = store.store(
			{ type: 'channel', channelId: crypto.randomUUID() },
			'second.mp4',
			Readable.from(Buffer.alloc(12, 2)),
		);

		let concurrencyError: unknown;
		try {
			await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2), { timeout: 500 });
		}
		catch (error) {
			concurrencyError = error;
		}
		finally {
			releaseFirstProbe();
		}
		await Promise.all([first, second]);
		if (concurrencyError) {
			throw concurrencyError;
		}
	});

	it('keeps active channel overrides readable while a global upload is probed', async () => {
		let releaseGlobalProbe: () => void = () => {};
		let markGlobalProbeStarted: () => void = () => {};
		const globalProbeStarted = new Promise<void>((resolve) => {
			markGlobalProbeStarted = resolve;
		});
		const globalProbeGate = new Promise<void>((resolve) => {
			releaseGlobalProbe = resolve;
		});
		let probeCalls = 0;
		const probe = vi.fn(async () => {
			probeCalls += 1;
			if (probeCalls === 2) {
				markGlobalProbeStarted();
				await globalProbeGate;
			}

			return probed(true);
		});
		const { store } = await fixture(probe);
		const channelId = crypto.randomUUID();
		await store.store(
			{ type: 'channel', channelId },
			'channel.mp4',
			Readable.from(Buffer.alloc(12, 1)),
		);
		const globalUpload = store.store(
			{ type: 'global' },
			'global.mp4',
			Readable.from(Buffer.alloc(12, 2)),
		);
		await globalProbeStarted;

		let resolvedSource: string | null = null;
		let resolveError: unknown;
		const channelRead = store.resolve(channelId).then(
			(result) => {
				resolvedSource = result.source;
			},
			(error) => {
				resolveError = error;
			},
		);
		let readError: unknown;
		try {
			await vi.waitFor(() => expect(resolvedSource).toBe('channel'), { timeout: 500 });
		}
		catch (error) {
			readError = error;
		}
		finally {
			releaseGlobalProbe();
		}
		await Promise.all([globalUpload, channelRead]);
		if (resolveError) {
			throw resolveError;
		}
		if (readError) {
			throw readError;
		}
	});

	it('replaces the active pair without retaining historical versions', async () => {
		const probe = vi.fn(async () => probed(true));
		const { root, store } = await fixture(probe);
		for (let index = 0; index < 3; index += 1) {
			await store.store(
				{ type: 'global' },
				`fallback-${index}.mp4`,
				Readable.from(Buffer.alloc(12, index + 1)),
			);
		}

		const directory = path.join(root, 'managed', 'global');
		expect(await readdir(directory)).toEqual(['current']);
		expect(await readFile(path.join(directory, 'current', 'asset'))).toEqual(Buffer.alloc(12, 3));
		expect((await store.status({ type: 'global' })).override?.filename).toBe('fallback-2.mp4');
	});

	it('preserves Matroska and WebM content types for their shared container name', async () => {
		const probe = vi.fn(async () => ({ ...probed(true), container: 'matroska,webm' }));
		const { store } = await fixture(probe);

		expect((await store.store(
			{ type: 'global' },
			'fallback.mkv',
			Readable.from(Buffer.alloc(12, 1)),
		)).override).toMatchObject({ filename: 'fallback.mkv', contentType: 'video/x-matroska' });
		expect((await store.store(
			{ type: 'global' },
			'fallback.webm',
			Readable.from(Buffer.alloc(12, 2)),
		)).override).toMatchObject({ filename: 'fallback.webm', contentType: 'video/webm' });
	});

	it('keeps the previous asset after a replacement fails validation', async () => {
		const probe = vi.fn()
			.mockResolvedValueOnce(probed(true))
			.mockRejectedValueOnce(new Error('probe failed'));
		const { root, store } = await fixture(probe);
		const asset = path.join(root, 'managed', 'global', 'current', 'asset');
		await store.store({ type: 'global' }, 'working.mp4', Readable.from(Buffer.alloc(12, 1)));

		await expect(store.store(
			{ type: 'global' },
			'broken.mp4',
			Readable.from(Buffer.alloc(12, 2)),
		)).rejects.toThrow('probe failed');
		expect(await readFile(asset)).toEqual(Buffer.alloc(12, 1));
		expect((await store.status({ type: 'global' })).override?.filename).toBe('working.mp4');
	});

	it('keeps the previous asset when replacement activation fails', async () => {
		const probe = vi.fn(async () => probed(true));
		const { root, store } = await fixture(probe);
		const asset = path.join(root, 'managed', 'global', 'current', 'asset');
		await store.store({ type: 'global' }, 'working.mp4', Readable.from(Buffer.alloc(12, 1)));

		const internal = store as unknown as {
			activate: (scope: { type: 'global' }) => Promise<void>;
		};
		internal.activate = vi.fn().mockRejectedValueOnce(new Error('activation failed'));

		await expect(store.store(
			{ type: 'global' },
			'replacement.mp4',
			Readable.from(Buffer.alloc(12, 2)),
		)).rejects.toThrow('activation failed');
		expect(await readFile(asset)).toEqual(Buffer.alloc(12, 1));
		expect((await store.status({ type: 'global' })).override?.filename).toBe('working.mp4');
	});

	it('restores the previous pair after an interrupted directory replacement', async () => {
		const probe = vi.fn(async () => probed(true));
		const { root, store } = await fixture(probe);
		await store.store({ type: 'global' }, 'working.mp4', Readable.from(Buffer.alloc(12, 1)));
		const directory = path.join(root, 'managed', 'global');
		await rename(path.join(directory, 'current'), path.join(directory, 'previous'));
		await mkdir(path.join(directory, 'staged'));

		const restarted = new FallbackFillerStore(
			path.join(root, 'managed'),
			path.resolve('apps/server/assets'),
			{ probe } as unknown as MediaProbe,
			{ warn: vi.fn() },
		);
		await restarted.start([]);

		expect((await restarted.status({ type: 'global' })).override?.filename).toBe('working.mp4');
		expect(await readdir(directory)).toEqual(['current']);
	});

	it('requires one video stream with the minimum measured duration', async () => {
		const shortVideo = probed(true, 90_000);
		shortVideo.streams[0]!.durationMilliseconds = FALLBACK_FILLER_MIN_DURATION_MILLISECONDS - 1;
		const multipleVideos = probed(true);
		multipleVideos.streams.push({
			...multipleVideos.streams[0]!,
			index: 2,
			isDefault: false,
		});
		const probe = vi.fn()
			.mockResolvedValueOnce(shortVideo)
			.mockResolvedValueOnce(multipleVideos)
			.mockResolvedValueOnce(probed(true, FALLBACK_FILLER_MIN_DURATION_MILLISECONDS));
		const { store } = await fixture(probe);

		await expect(store.store(
			{ type: 'global' },
			'short.mp4',
			Readable.from(Buffer.alloc(12, 1)),
		)).rejects.toThrow('at least 30 seconds');
		await expect(store.store(
			{ type: 'global' },
			'multiple.mp4',
			Readable.from(Buffer.alloc(12, 2)),
		)).rejects.toThrow('exactly one video stream');
		await store.store({ type: 'global' }, 'minimum.mp4', Readable.from(Buffer.alloc(12, 3)));
		expect((await store.status({ type: 'global' })).override?.durationMilliseconds)
			.toBe(FALLBACK_FILLER_MIN_DURATION_MILLISECONDS);
	});

	it('falls through from incomplete managed state and keeps it removable', async () => {
		const probe = vi.fn(async () => probed(true));
		const { root, store } = await fixture(probe);
		await store.store({ type: 'global' }, 'working.mp4', Readable.from(Buffer.alloc(12, 1)));
		await unlink(path.join(root, 'managed', 'global', 'current', 'asset'));

		expect(await store.status({ type: 'global' })).toMatchObject({
			override: null,
			overrideConfigured: true,
			effective: { source: 'bundled' },
			overrideError: expect.stringContaining('unavailable'),
		});
		expect(await store.remove({ type: 'global' })).toMatchObject({
			overrideConfigured: false,
			effective: { source: 'bundled' },
			overrideError: null,
		});
	});

	it('rejects unsupported extensions after draining the upload', async () => {
		const { store } = await fixture(vi.fn(async () => probed(true)));
		const upload = Readable.from(Buffer.alloc(12));

		await expect(store.store({ type: 'global' }, 'fallback.txt', upload))
			.rejects.toBeInstanceOf(FallbackFillerValidationError);
		expect(upload.readableEnded).toBe(true);
	});

	it('removes fallback directories for channels deleted while the server was stopped', async () => {
		const probe = vi.fn(async () => probed(true));
		const { root, store } = await fixture(probe);
		const channelId = crypto.randomUUID();
		await store.store(
			{ type: 'channel', channelId },
			'orphaned.mp4',
			Readable.from(Buffer.alloc(12, 1)),
		);
		const directory = path.join(root, 'managed', 'channels', channelId);
		await expect(access(directory)).resolves.toBeUndefined();

		const restarted = new FallbackFillerStore(
			path.join(root, 'managed'),
			path.resolve('apps/server/assets'),
			{ probe } as unknown as MediaProbe,
			{ warn: vi.fn() },
		);
		await restarted.start([]);

		await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('treats mismatched metadata as unavailable instead of playing the wrong bytes', async () => {
		const probe = vi.fn(async () => probed(true));
		const { root, store } = await fixture(probe);
		await store.store({ type: 'global' }, 'working.mp4', Readable.from(Buffer.alloc(12, 1)));
		await writeFile(path.join(root, 'managed', 'global', 'current', 'asset'), Buffer.alloc(3));

		expect(await store.status({ type: 'global' })).toMatchObject({
			override: null,
			overrideConfigured: true,
			effective: { source: 'bundled' },
		});
	});

	it('probes persisted overrides at startup before selecting them for playback', async () => {
		const probe = vi.fn()
			.mockResolvedValueOnce(probed(true, 90_000))
			.mockResolvedValueOnce(probed(true, 120_000));
		const { root, store } = await fixture(probe);
		await store.store({ type: 'global' }, 'working.mp4', Readable.from(Buffer.alloc(12, 1)));
		const restarted = new FallbackFillerStore(
			path.join(root, 'managed'),
			path.resolve('apps/server/assets'),
			{ probe } as unknown as MediaProbe,
			{ warn: vi.fn() },
		);

		await restarted.start([]);

		expect(await restarted.status({ type: 'global' })).toMatchObject({
			override: null,
			overrideConfigured: true,
			effective: { source: 'bundled' },
			overrideError: expect.stringContaining('unavailable'),
		});
	});
});
