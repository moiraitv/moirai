import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { channelCreateSchema, remotePlaybackReference, type Channel, type ScheduleGuide, type TimelineSegment } from '@moirai/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Repository } from '@server/repository/index.js';
import type { FallbackFillerStore } from '@server/playback/fallback-filler-store.js';
import type { SchedulingWorkerPool } from '@server/scheduling/worker-pool.js';
import { SubtitleAssets } from '@server/playback/subtitle-assets.js';
import { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(block = false, failFirst = false) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-remote-subtitle-priority-'));
	roots.push(root);
	const log = path.join(root, 'requests');
	const ffmpeg = path.join(root, 'ffmpeg.cjs');
	await writeFile(ffmpeg, String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const part = new URL(args[args.indexOf('-i') + 1]).searchParams.get('part');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ part, pid: process.pid }) + '\n');
${failFirst ? "if (args[args.indexOf('-map') + 1] === '0:1') { process.exit(1); }" : ''}
fs.writeFileSync(args.at(-1), '[Script Info]\n');
${block ? 'setInterval(() => {}, 1000);' : ''}
`, { mode: 0o700 });
	const now = Date.now();
	const channel: Channel = {
		...channelCreateSchema.parse({ number: '1', name: 'Remote', subtitleMode: 'burn', subtitlePreferences: { policy: 'any' } }),
		id: randomUUID(), ffmpegPath: ffmpeg, createdAt: '', updatedAt: '',
	};
	const server = randomUUID();
	const subtitle = {
		id: 'embedded', sourceType: 'embedded', partNumber: 1, streamIndex: 1, codec: 'subrip', format: null,
		language: 'eng', title: null, isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: false,
		relativePaths: [], playbackPaths: [],
	};
	const media = ['past', 'current', 'future'].map(id => ({
		id, libraryId: 'library', kind: 'movie', title: id, playbackPath: remotePlaybackReference(server, id),
		durationSeconds: 600, parts: [], subtitleTracks: failFirst ? [subtitle, { ...subtitle, id: 'fallback', streamIndex: 2 }] : [subtitle], fileModifiedAt: 'version',
	}));
	const segments: TimelineSegment[] = media.map((item, index) => ({
		id: item.id, channelId: channel.id, mediaItemId: item.id, playbackPath: item.playbackPath, title: item.title,
		role: 'primary', scheduleLayerId: null, templateId: 'template', slotId: 'slot', programId: null,
		start: new Date(now + (index - 1) * 3_600_000 - 1_000).toISOString(),
		finish: new Date(now + (index - 1) * 3_600_000 + 599_000).toISOString(),
		sourceStartSeconds: 0, sourceFinishSeconds: 600, truncated: false,
	}));
	const guide: ScheduleGuide = {
		timeZone: 'UTC', startDate: new Date(now).toISOString().slice(0, 10), days: 2, requestedDays: 2,
		segmentLimitApplied: false, channels: [{ channelId: channel.id, preview: {
			channelId: channel.id, timeZone: 'UTC', startDate: '', days: 2,
			segments: [segments[2]!, segments[0]!, segments[1]!], issues: [], proposedState: [],
		} }],
	};
	const repository = {
		getChannel: async () => channel, listPrograms: async () => [],
		creditTemplates: { media: async () => new Map(media.map(item => [item.id, item])), list: async () => [] },
	} as unknown as Repository;
	const remote = { origin: 'http://127.0.0.1:1', secret: 'synthetic-secret' };
	const assets = new SubtitleAssets(root, repository, remote);
	const requests = async (): Promise<Array<{ part: string; pid: number }>> => {
		try {
			return (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw error;
		}
	};
	return { root, channel, guide, repository, remote, assets, requests };
}

it('starts a cold live pass without fetching current, future, or expired remote subtitles', async () => {
	const f = await fixture(true);
	try {
		const prepared = await f.assets.prepare(f.channel, f.guide, undefined, () => true);
		expect(await f.requests()).toEqual([]);
		expect([...prepared.values()]).toEqual([[null], [null], [null]]);
		expect(f.assets.issues.get(f.channel.id)).toHaveLength(1);
	}
	finally {
		f.assets.close();
	}
});

it('prepares one uncached file per background pass, prioritizes the current airing, and reuses live snapshots', async () => {
	const f = await fixture();
	try {
		const first = await f.assets.prepare(f.channel, f.guide);
		expect((await f.requests()).map(request => request.part)).toEqual(['current']);
		expect(first.get('current')![0]!.path).toBeTruthy();
		expect(first.get('future')).toEqual([null]);
		const live = await f.assets.prepare(f.channel, f.guide, undefined, () => true);
		expect(live.get('current')).toEqual(first.get('current'));
		expect(await f.requests()).toHaveLength(1);
		const second = await f.assets.prepare(f.channel, f.guide);
		expect((await f.requests()).map(request => request.part)).toEqual(['current', 'future']);
		expect(second.get('future')![0]!.path).toBeTruthy();
		expect(second.get('past')).toEqual([null]);
	}
	finally {
		f.assets.close();
	}
});

it('promotes shared background extraction and publishes live playout without completing the blocked read', async () => {
	const f = await fixture(true);
	const filename = '20260901T000000.000000000+0000_20260902T000000.000000000+0000.json';
	const workers = {
		databaseBacked: true, playoutRevision: () => 'same', promotePlayout: vi.fn(),
		playoutRead: vi.fn(async (request: { kind: string }) => request.kind === 'playout-preparation'
			? { channel: f.channel, guide: f.guide, programs: [] }
			: new Map([[filename, JSON.stringify({ items: [] })]])),
	};
	const synchronizer = new PlayoutSynchronizer(
		f.repository,
		f.root,
		'UTC',
		60,
		async () => {},
		{ resolve: async () => ({}) } as unknown as FallbackFillerStore,
		{ publish: vi.fn() },
		{ warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger,
		workers as unknown as SchedulingWorkerPool,
		undefined,
		undefined,
		undefined,
		undefined,
		f.remote,
	);
	const periodic = synchronizer.syncChannel(f.channel.id);
	try {
		await vi.waitFor(async () => expect(await f.requests()).toHaveLength(1));
		const pid = (await f.requests())[0]!.pid;
		const live = synchronizer.syncChannel(f.channel.id, true);
		expect(live).toBe(periodic);
		const folder = await live;
		expect(JSON.parse(await readFile(path.join(folder, filename), 'utf8'))).toEqual({ items: [] });
		expect((await f.requests()).map(request => request.part)).toEqual(['current']);
		expect(await readdir(path.join(f.root, f.channel.id, 'subtitles'))).toEqual([]);
		expect(() => process.kill(pid, 0)).toThrow();
		expect(workers.playoutRead).toHaveBeenCalledTimes(2);
	}
	finally {
		await synchronizer.close();
		await periodic.catch(() => {});
	}
});

it('stops extraction and removes unpublished files before shutdown completes', async () => {
	const f = await fixture(true);
	const preparing = f.assets.prepare(f.channel, f.guide);
	try {
		await vi.waitFor(async () => expect(await f.requests()).toHaveLength(1));
		const pid = (await f.requests())[0]!.pid;
		f.assets.close();
		await preparing;
		expect(() => process.kill(pid, 0)).toThrow();
		expect(await readdir(path.join(f.root, f.channel.id, 'subtitles'))).toEqual([]);
		expect(await f.requests()).toHaveLength(1);
	}
	finally {
		f.assets.close();
		await preparing;
	}
});

it('tries another track in the admitted file without admitting future files after a failed candidate', async () => {
	const f = await fixture(false, true);
	try {
		const prepared = await f.assets.prepare(f.channel, f.guide);
		expect((await f.requests()).map(request => request.part)).toEqual(['current', 'current']);
		expect(prepared.get('current')![0]!.path).toBeTruthy();
		expect(prepared.get('future')).toEqual([null]);
		const live = await f.assets.prepare(f.channel, f.guide, undefined, () => true);
		expect(live.get('current')).toEqual(prepared.get('current'));
		expect(await f.requests()).toHaveLength(2);
	}
	finally {
		f.assets.close();
	}
});
