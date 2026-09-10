import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelCreateSchema, MUSIC_VIDEO_CREDIT_TEMPLATE, type Channel, type MediaItem, type MediaSubtitleTrack, type ScheduleGuide, type TimelineSegment } from '@moirai/shared';
import { selectSubtitle, subtitleLanguageKey } from '@server/playback/subtitle-selection.js';
import { assTimestamp, escapeAssText, renderCredits } from '@server/playback/credit-render.js';
import { renderCreditTemplate } from '@server/playback/credit-renderer.js';
import * as sourceFiles from '@server/media/source-file.js';
import * as creditRenderer from '@server/playback/credit-renderer.js';
import { creditContext } from '@server/playback/credit-context.js';
import { previewCredits } from '@server/playback/credit-preview.js';
import { SubtitleAssets } from '@server/playback/subtitle-assets.js';
import { buildEtvPlayoutFiles } from '@server/playback/playout-output.js';
import type { Repository } from '@server/repository/index.js';

const testFfmpeg = process.env.MOIRAI_TEST_FFMPEG ?? 'ffmpeg';
const hasAss = execFileSync(testFfmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes(' subtitles ');
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); 
});
function channel(): Channel {
	return { ...channelCreateSchema.parse({ number: '1', name: 'Music', video: { width: 320, height: 180 } }), ffmpegPath: testFfmpeg, id: randomUUID(), createdAt: '', updatedAt: '' };
}
function item(): MediaItem {
	return { id: randomUUID(), libraryId: randomUUID(), groupId: null, kind: 'music-video', title: 'A song', sortTitle: 'A song',
		relativePath: 'video.mkv', playbackPath: '/video.mkv', plot: null, year: 2025, releaseDate: null, durationSeconds: 180,
		seasonNumber: null, episodeNumber: null, episodeEndNumber: null, edition: null, externalIds: [], trackNumber: 1, discNumber: null,
		artists: ['Artist', 'Artist'], multipartStatus: 'none', parts: [], subtitleTracks: [], metadataStatus: 'complete', availability: 'available',
		lastObservedAt: null, metadata: { album: 'Album', studio: ['Studio'], directors: ['Director'] }, artworkUrl: null, createdAt: '', updatedAt: '',
		fileModifiedAt: null, dateAddedAt: '', titleBucket: 'A' };
}
function track(overrides: Partial<MediaSubtitleTrack> = {}): MediaSubtitleTrack {
	return { id: randomUUID(), sourceType: 'embedded', partNumber: 1, streamIndex: 2, codec: 'subrip', format: null, language: 'eng', title: null,
		isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: false, relativePaths: [], playbackPaths: [], ...overrides };
}
function segment(configured: Channel, media: MediaItem): TimelineSegment {
	return { id: randomUUID(), channelId: configured.id, role: 'primary', scheduleLayerId: null, templateId: randomUUID(), slotId: randomUUID(),
		programId: null, mediaItemId: media.id, title: media.title, playbackPath: media.playbackPath,
		start: '2026-09-01T23:59:00Z', finish: '2026-09-02T00:02:00Z', sourceStartSeconds: 0, sourceFinishSeconds: 180, truncated: false };
}
function guide(configured: Channel, entry: TimelineSegment): ScheduleGuide {
	return { timeZone: 'UTC', startDate: '2026-09-01', requestedDays: 2, days: 2, segmentLimitApplied: false, channels: [{ channelId: configured.id,
		preview: { channelId: configured.id, timeZone: 'UTC', startDate: '2026-09-01', days: 2, segments: [entry], issues: [], proposedState: [] } }] };
}

describe('subtitle selection', () => {
	it('matches two-letter, bibliographic, and terminological language aliases', () => {
		expect(subtitleLanguageKey('EN')).toBe(subtitleLanguageKey('eng'));
		expect(subtitleLanguageKey('fre')).toBe(subtitleLanguageKey('fra'));
		expect(subtitleLanguageKey('de-DE')).toBe(subtitleLanguageKey('ger'));
	});
	it('requires forced flags and never falls back across an explicit language boundary', () => {
		const forced = track({ isForced: true });
		expect(selectSubtitle([track(), forced], { policy: 'forced', language: 'en' }, 1)).toBe(forced);
		expect(selectSubtitle([forced], { policy: 'any', language: 'es' }, 1)).toBeNull();
		expect(selectSubtitle([track()], { policy: 'forced' }, 1)).toBeNull();
		expect(selectSubtitle([forced], {}, 1)).toBeNull();
	});
	it('prefers default flags with a deterministic fallback and excludes other physical parts', () => {
		const normal = track({ streamIndex: 2 });
		const preferred = track({ streamIndex: 3, isDefault: true });
		expect(selectSubtitle([normal, preferred], { policy: 'default' }, 1)).toBe(preferred);
		expect(selectSubtitle([preferred, normal], { policy: 'any' }, 1)).toBe(normal);
		expect(selectSubtitle([normal], { policy: 'default' }, 1)).toBe(normal);
		expect(selectSubtitle([normal], { policy: 'any' }, 2)).toBeNull();
	});
	it('resolves channel, sequence, and leaf preferences independently', () => {
		const configured = channel();
		configured.subtitlePreferences = { policy: 'forced', language: 'en', creditsTemplateId: randomUUID() };
		const entry = { ...segment(configured, item()), programAncestry: ['outer', 'inner'] };
		const assets = new SubtitleAssets('/unused', {} as Repository);
		expect(assets.preferences(configured, entry, new Map([['outer', { policy: 'any' }], ['inner', { language: null, creditsTemplateId: null }]])))
			.toEqual({ policy: 'any', language: null, creditsTemplateId: null });
	});
});

describe('Liquid music-video credits', () => {
	it('renders overlapping channel work beyond worker capacity without dropping credits', async () => {
		const context = creditContext(item(), channel());
		const results = await Promise.all(Array.from({ length: creditRenderer.MAX_ACTIVE_CREDIT_RENDERS + 1 }, () => renderCreditTemplate(MUSIC_VIDEO_CREDIT_TEMPLATE, context)));
		for (const ass of results) {
			expect(ass).toContain('0:00:07.00,0:00:17.00');
		}
	}, 15_000);
	it('renders fixed opening/closing intervals and deduplicated metadata in an isolated worker', async () => {
		const ass = await renderCreditTemplate(MUSIC_VIDEO_CREDIT_TEMPLATE, creditContext(item(), channel()));
		expect(ass).toContain('0:00:07.00,0:00:17.00');
		expect(ass).toContain('0:02:45.00,0:02:55.00');
		expect(ass).not.toContain('Artist | Artist');
		expect(ass).toContain('Director: Director');
	});
	it('omits opening events on short videos and safely handles absent metadata', async () => {
		const media = { ...item(), durationSeconds: 10, artists: [], year: null, metadata: {} };
		const ass = await renderCredits(MUSIC_VIDEO_CREDIT_TEMPLATE, creditContext(media, channel()));
		expect(ass).not.toContain('0:00:07.00');
		expect(ass).toContain('0:00:00.00,0:00:05.00');
		expect(ass).not.toContain('Director:');
	});
	it('escapes provider text and rejects undefined variables, file loading, and invalid ASS', async () => {
		expect(escapeAssText('{\\pos(1,2)}\nSong')).toBe('｛＼pos(1,2)｝\\NSong');
		expect(assTimestamp(3661.25)).toBe('1:01:01.25');
		const context = creditContext(item(), channel());
		await expect(renderCredits(MUSIC_VIDEO_CREDIT_TEMPLATE + '{{ undefined_margin }}', context)).rejects.toThrow();
		await expect(renderCredits('{% include "secret" %}', context)).rejects.toThrow('disabled');
		await expect(renderCredits('plain text', context)).rejects.toThrow('ASS');
		await expect(renderCredits(MUSIC_VIDEO_CREDIT_TEMPLATE + '\nDialogue: 0,0:00:09.00,0:00:02.00,Title,,0,0,0,,Bad', context)).rejects.toThrow();
	});
	it('bounds pathological author loops without blocking the caller', async () => {
		await expect(renderCreditTemplate('{% for i in (1..100000000) %}x{% endfor %}', {})).rejects.toThrow();
	});
});

describe('subtitle assets and playout', () => {
	it.each(['programs', 'media', 'templates'])('keeps playback available when subtitle %s metadata cannot load', async (failure) => {
		const configured = channel();
		configured.subtitlePreferences = { policy: 'any' };
		const media = item();
		const unavailable = async () => {
			throw new Error('Database unavailable');
		};
		const repository = {
			listPrograms: failure === 'programs' ? unavailable : async () => [],
			creditTemplates: {
				media: failure === 'media' ? unavailable : async () => new Map([[media.id, media]]),
				list: failure === 'templates' ? unavailable : async () => [],
			},
		} as unknown as Repository;
		const assets = new SubtitleAssets('/unused', repository);
		const entry = segment(configured, media);
		const prepared = await assets.prepare(configured, guide(configured, entry));
		expect(prepared.size).toBe(0);
		expect(prepared.subtitleMode).toBeUndefined();
		expect(assets.issues.get(configured.id)).toHaveLength(1);
		const documents = [...buildEtvPlayoutFiles([configured], guide(configured, entry), new Map(), prepared).values()].map((value) => JSON.parse(value));
		expect(documents[0].items[0].source.path).toBe(media.playbackPath);
		expect(documents[0].items[0].tracks?.subtitle).toBeUndefined();
	});
	it('publishes video without credits on renderer overload and retries on the next pass', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-credit-overload-'));
		roots.push(root);
		const configured = channel();
		const media = item();
		const template = { id: randomUUID(), source: MUSIC_VIDEO_CREDIT_TEMPLATE };
		configured.subtitlePreferences = { creditsTemplateId: template.id };
		const repository = { listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [template] } } as unknown as Repository;
		const assets = new SubtitleAssets(root, repository);
		const render = vi.spyOn(creditRenderer, 'renderCreditTemplate').mockRejectedValueOnce(new creditRenderer.CreditRendererBusyError());
		try {
			const entry = segment(configured, media);
			const prepared = await assets.prepare(configured, guide(configured, entry));
			expect(prepared.get(entry.id)).toEqual([null]);
			expect(assets.issues.get(configured.id)?.[0]).toContain('busy');
			const documents = [...buildEtvPlayoutFiles([configured], guide(configured, entry), new Map(), prepared).values()].map((value) => JSON.parse(value));
			expect(documents[0].items[0].source.path).toBe(media.playbackPath);
			const retried = await assets.prepare(configured, guide(configured, entry));
			expect(retried.get(entry.id)?.[0]?.path).toBeTruthy();
			expect(assets.issues.get(configured.id)).toEqual([]);
		}
		finally {
			render.mockRestore();
		}
	});
	it('publishes reusable ASS before referencing it and carries source time across parts and midnight', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-credit-assets-'));
		roots.push(root);
		const configured = channel();
		const media = item();
		const template = { id: randomUUID(), source: MUSIC_VIDEO_CREDIT_TEMPLATE };
		configured.subtitlePreferences = { creditsTemplateId: template.id };
		const repository = { listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [template] } } as unknown as Repository;
		const assets = new SubtitleAssets(root, repository);
		const entry = { ...segment(configured, media), playbackParts: [{ playbackPath: '/part1.mkv', durationSeconds: 90 }, { playbackPath: '/part2.mkv', durationSeconds: 90 }] };
		const schedule = guide(configured, entry);
		const prepared = await assets.prepare(configured, schedule);
		const file = prepared.get(entry.id)![0]!.path!;
		expect(await readFile(file, 'utf8')).toContain('[Events]');
		const before = await stat(file);
		const repeated = await assets.prepare(configured, schedule);
		expect(repeated.get(entry.id)![0]!.path).toBe(file);
		expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
		const documents = [...buildEtvPlayoutFiles([configured], schedule, new Map(), prepared).values()].map((value) => JSON.parse(value));
		expect(documents[0].items[0].tracks.subtitle.source.in_point_ms).toBe(0);
		expect(documents[1].items[0].tracks.subtitle.source.in_point_ms).toBe(60_000);
		expect(documents[1].items[1].tracks.subtitle.source.in_point_ms).toBe(90_000);
		template.source += '\n; Changed';
		const changed = await assets.prepare(configured, schedule);
		expect(changed.get(entry.id)![0]!.path).not.toBe(file);
		expect(await readFile(file, 'utf8')).toContain('[Events]');
	});
	it('retains video and reports a contextual issue when generation fails', async () => {
		const configured = channel();
		const media = item();
		configured.subtitlePreferences = { creditsTemplateId: randomUUID() };
		const repository = { listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [] } } as unknown as Repository;
		const assets = new SubtitleAssets('/unused', repository);
		const entry = segment(configured, media);
		const prepared = await assets.prepare(configured, guide(configured, entry));
		expect(prepared.get(entry.id)).toEqual([null]);
		expect(assets.issues.get(configured.id)?.[0]).toContain(media.title);
	});
	it.skipIf(!hasAss)('extracts embedded text for Burn, retains direct indices for Convert, and renders visible credit frames', async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'moirai-credit-ffmpeg-'));
		roots.push(root);
		const video = path.join(root, 'video.mkv');
		const srt = path.join(root, 'subtitle.srt');
		await writeFile(srt, '1\n00:00:01,000 --> 00:00:15,000\nEmbedded caption\n');
		execFileSync(testFfmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=10:d=20', '-i', srt, '-map', '0:v', '-map', '1:s', '-c:v', 'mpeg4', '-c:s', 'srt', video]);
		const media = { ...item(), playbackPath: video, subtitleTracks: [track({ streamIndex: 1 })] };
		const configured = channel();
		configured.subtitlePreferences = { policy: 'any' };
		const repository = { listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [] } } as unknown as Repository;
		const assets = new SubtitleAssets(root, repository);
		const entry = segment(configured, media);
		const burned = await assets.prepare(configured, guide(configured, entry));
		expect(await readFile(burned.get(entry.id)![0]!.path!, 'utf8')).toContain('Embedded caption');
		configured.subtitleMode = 'convert';
		expect((await assets.prepare(configured, guide(configured, entry))).get(entry.id)).toEqual([{ streamIndex: 1 }]);
		const absent = await previewCredits(MUSIC_VIDEO_CREDIT_TEMPLATE, media, configured, 1);
		const visible = await previewCredits(MUSIC_VIDEO_CREDIT_TEMPLATE, media, configured, 10);
		const pixels = async (image: string) => (await sharp(Buffer.from(image.split(',')[1]!, 'base64')).stats()).channels[0]!.sum;
		expect(await pixels(visible.image)).toBeGreaterThan(await pixels(absent.image));
		media.kind = 'movie';
		configured.subtitlePreferences.creditsTemplateId = randomUUID();
		const forced = await assets.prepare(configured, guide(configured, entry));
		expect(forced.subtitleMode).toBe('burn');
		expect(await readFile(forced.get(entry.id)![0]!.path!, 'utf8')).toContain('Embedded caption');
		expect(configured.subtitleMode).toBe('convert');
	}, 30_000);
});

it.each(['burn', 'convert'] as const)('omits malformed sidecars in %s mode and accepts them after repair', async (mode) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-sidecar-validation-'));
	roots.push(root);
	const configured = channel();
	configured.subtitleMode = mode;
	configured.subtitlePreferences = { policy: 'any' };
	const file = path.join(root, 'video.srt');
	await writeFile(file, 'This is not subtitle data.');
	const media = item();
	media.subtitleTracks = [track({ sourceType: 'sidecar', format: 'srt', streamIndex: null, playbackPaths: [file] })];
	const entry = segment(configured, media);
	const repository = { getLibraryPlaybackRoots: async () => new Map([[media.libraryId, root]]), listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [] } } as unknown as Repository;
	const assets = new SubtitleAssets(root, repository);
	const prepared = await assets.prepare(configured, guide(configured, entry));
	expect(prepared.get(entry.id)).toEqual([null]);
	expect(assets.issues.get(configured.id)).toHaveLength(1);
	const documents = [...buildEtvPlayoutFiles([configured], guide(configured, entry), new Map(), prepared).values()].map((value) => JSON.parse(value));
	expect(documents[0].items[0].source).toMatchObject({ source_type: 'local', path: media.playbackPath });
	expect(documents[0].items[0].tracks?.subtitle).toBeUndefined();

	await writeFile(file, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
	const repaired = await assets.prepare(configured, guide(configured, entry));
	const snapshot = repaired.get(entry.id)![0]!.path!;
	expect(snapshot).not.toBe(file);
	await rm(file);
	expect(await readFile(snapshot, 'utf8')).toContain('Hello');
	expect(assets.issues.get(configured.id)).toEqual([]);
});

it('probes multi-language VobSub sidecars and publishes the matching stream index', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-vobsub-'));
	roots.push(root);
	const configured = channel();
	const file = path.join(root, 'video.idx');
	await writeFile(file, 'fixture');
	await writeFile(path.join(root, 'video.sub'), 'paired fixture');
	const probe = path.join(root, 'ffprobe');
	await writeFile(probe, `#!${process.execPath}
process.stdout.write(JSON.stringify({streams:[{index:0,tags:{language:'fra'}},{index:1,tags:{language:'eng'},disposition:{default:1}}]}));
`, { mode: 0o755 });
	configured.ffprobePath = probe;
	configured.subtitlePreferences = { policy: 'any', language: 'en' };
	const media = item();
	media.subtitleTracks = [track({ sourceType: 'sidecar', format: 'vobsub', codec: 'dvd_subtitle', streamIndex: null, language: null, playbackPaths: [file, path.join(root, 'video.sub')] })];
	const entry = segment(configured, media);
	const repository = { getLibraryPlaybackRoots: async () => new Map([[media.libraryId, root]]), listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [] } } as unknown as Repository;
	const assets = new SubtitleAssets(root, repository);
	const selected = await assets.prepare(configured, guide(configured, entry));
	const snapshot = selected.get(entry.id)![0]!.path!;
	expect(snapshot).not.toBe(file);
	expect(selected.get(entry.id)).toEqual([{ path: snapshot, streamIndex: 1, offsetMs: 0 }]);
	expect(await readFile(snapshot.replace(/\.idx$/, '.sub'), 'utf8')).toBe('paired fixture');
	const documents = [...buildEtvPlayoutFiles([configured], guide(configured, entry), new Map(), selected).values()].map((value) => JSON.parse(value));
	expect(documents[0].items[0].tracks.subtitle).toMatchObject({ stream_index: 1, source: { path: snapshot } });
	configured.subtitlePreferences.language = 'es';
	expect((await assets.prepare(configured, guide(configured, entry))).get(entry.id)).toEqual([null]);
});

it('forces channel-wide Burn for inherited scheduled credits and restores Convert when disabled', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-credit-mode-'));
	roots.push(root);
	const configured = channel();
	configured.subtitleMode = 'convert';
	const media = item();
	const template = { id: randomUUID(), source: MUSIC_VIDEO_CREDIT_TEMPLATE };
	const sequenceId = randomUUID();
	const leafId = randomUUID();
	const programs = [{ id: sequenceId, config: { subtitlePreferences: { creditsTemplateId: template.id } } }, { id: leafId, config: { subtitlePreferences: {} as Record<string, string | null> } }];
	const repository = { listPrograms: async () => programs, creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [template] } } as unknown as Repository;
	const assets = new SubtitleAssets(root, repository);
	const entry = { ...segment(configured, media), programAncestry: [sequenceId, leafId] };
	const prepared = await assets.prepare(configured, guide(configured, entry));
	expect(prepared.subtitleMode).toBe('burn');
	expect(await readFile(prepared.get(entry.id)![0]!.path!, 'utf8')).toContain('[Events]');
	expect(configured.subtitleMode).toBe('convert');
	programs[1]!.config.subtitlePreferences = { creditsTemplateId: null };
	const disabled = await assets.prepare(configured, guide(configured, entry));
	expect(disabled.subtitleMode).toBe('convert');
	expect(disabled.size).toBe(0);
});

it.each(['embedded', 'sidecar'] as const)('keeps a valid %s subtitle when a VobSub probe fails', async (sourceType) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-vobsub-failure-'));
	roots.push(root);
	const configured = channel();
	configured.subtitleMode = 'convert';
	configured.subtitlePreferences = { policy: 'any', language: 'en' };
	const file = path.join(root, 'video.srt');
	await writeFile(file, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
	const media = item();
	media.subtitleTracks = [
		track({ sourceType: 'sidecar', format: 'vobsub', streamIndex: null, playbackPaths: [path.join(root, 'video.idx')] }),
		track({ sourceType, streamIndex: sourceType === 'embedded' ? 2 : null, format: sourceType === 'sidecar' ? 'srt' : null, playbackPaths: sourceType === 'sidecar' ? [file] : [] }),
	];
	const repository = { getLibraryPlaybackRoots: async () => new Map([[media.libraryId, root]]), listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [] } } as unknown as Repository;
	const assets = new SubtitleAssets(root, repository);
	const entry = segment(configured, media);
	const prepared = await assets.prepare(configured, guide(configured, entry));
	expect(prepared.get(entry.id)).toEqual([sourceType === 'embedded' ? { streamIndex: 2 } : { path: expect.stringContaining(path.join(configured.id, 'subtitles')), offsetMs: 0 }]);
	expect(assets.issues.get(configured.id)).toHaveLength(1);
});

it.each(['symlink', 'parent', 'traversal', 'missing', 'directory', 'idx', 'sub'])('rejects indexed sidecar %s replacements without publishing outside content', async (replacement) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-sidecar-boundary-'));
	roots.push(root);
	const library = path.join(root, 'library');
	await mkdir(library);
	const outside = path.join(root, 'outside.srt');
	await writeFile(outside, '1\n00:00:01,000 --> 00:00:02,000\nOutside content\n');
	const pair = replacement === 'idx' || replacement === 'sub';
	const file = path.join(library, pair ? 'video.idx' : 'video.srt');
	const companion = path.join(library, 'video.sub');
	await writeFile(file, 'original');
	await writeFile(companion, 'original pair');
	const media = item();
	media.subtitleTracks = [track({ sourceType: 'sidecar', format: pair ? 'vobsub' : 'srt', streamIndex: null, playbackPaths: pair ? [file, companion] : [file] })];
	const target = replacement === 'sub' ? companion : file;
	await rm(target);
	if (replacement === 'directory') {
		await mkdir(target);
	}
	else if (replacement === 'parent') {
		await rm(library, { recursive: true });
		await mkdir(path.join(root, 'outside-folder'));
		await writeFile(path.join(root, 'outside-folder', 'video.srt'), await readFile(outside));
		await mkdir(library);
		await symlink(path.join(root, 'outside-folder'), path.join(library, 'escaped'));
		media.subtitleTracks[0]!.playbackPaths = [path.join(library, 'escaped', 'video.srt')];
	}
	else if (replacement === 'traversal') {
		media.subtitleTracks[0]!.playbackPaths = [path.join(library, '..', 'outside.srt')];
	}
	else if (replacement !== 'missing') {
		await symlink(outside, target);
	}
	const opened: sourceFiles.OpenedSourceFile[] = [];
	const originalOpen = sourceFiles.openSourceFile;
	vi.spyOn(sourceFiles, 'openSourceFile').mockImplementation(async (...args) => {
		const source = await originalOpen(...args);
		opened.push(source);
		return source;
	});
	const configured = channel();
	configured.subtitlePreferences = { policy: 'any' };
	const entry = segment(configured, media);
	const repository = { getLibraryPlaybackRoots: async () => new Map([[media.libraryId, library]]), listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [] } } as unknown as Repository;
	const output = path.join(root, 'assets');
	const assets = new SubtitleAssets(output, repository);
	const prepared = await assets.prepare(configured, guide(configured, entry));
	expect(prepared.get(entry.id)).toEqual([null]);
	expect(assets.issues.get(configured.id)).toHaveLength(1);
	expect(await readdir(output).catch(() => [])).toEqual([]);
	for (const source of opened) {
		expect(source.handle.fd).toBe(-1);
	}
	const documents = [...buildEtvPlayoutFiles([configured], guide(configured, entry), new Map(), prepared).values()].map((value) => JSON.parse(value));
	expect(documents[0].items[0].source.path).toBe(media.playbackPath);
	if (replacement === 'symlink') {
		await rm(file);
		await writeFile(file, '1\n00:00:01,000 --> 00:00:02,000\nRepaired caption\n');
		const repaired = await assets.prepare(configured, guide(configured, entry));
		expect(await readFile(repaired.get(entry.id)![0]!.path!, 'utf8')).toContain('Repaired caption');
		expect(assets.issues.get(configured.id)).toEqual([]);
	}
});

it.each([false, true])('copies validated descriptors under a mapped root (symlinked: %s), ignoring replacement and old snapshots', async (linked) => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-sidecar-descriptor-'));
	roots.push(root);
	const library = path.join(root, 'mapped');
	await mkdir(library);
	const alias = path.join(root, 'alias');
	await symlink(library, alias);
	const trustedRoot = linked ? alias : library;
	const file = path.join(trustedRoot, 'video.srt');
	const content = '1\n00:00:01,000 --> 00:00:02,000\nTrusted caption\n';
	await writeFile(file, content);
	const outside = path.join(root, 'outside.srt');
	await writeFile(outside, '1\n00:00:01,000 --> 00:00:02,000\nOutside caption\n');
	const configured = channel();
	configured.subtitlePreferences = { policy: 'any' };
	const media = item();
	media.subtitleTracks = [track({ sourceType: 'sidecar', format: 'srt', streamIndex: null, playbackPaths: [file] })];
	const output = path.join(root, 'assets');
	const directory = path.join(output, configured.id, 'subtitles');
	await mkdir(directory, { recursive: true });
	const info = await stat(file);
	const oldKey = JSON.stringify({ sidecar: [{ path: file, size: info.size, modified: info.mtimeMs }] });
	const oldSnapshot = path.join(directory, createHash('sha256').update(oldKey).digest('hex') + '.srt');
	await writeFile(oldSnapshot, await readFile(outside));
	const originalOpen = sourceFiles.openSourceFile;
	let opened: sourceFiles.OpenedSourceFile | undefined;
	const open = vi.spyOn(sourceFiles, 'openSourceFile').mockImplementation(async (...args) => {
		opened = await originalOpen(...args);
		await rename(file, path.join(library, 'original.srt'));
		await symlink(outside, file);
		return opened;
	});
	const lookup = vi.fn(async () => new Map([[media.libraryId, trustedRoot]]));
	const repository = { getLibraryPlaybackRoots: lookup, listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [] } } as unknown as Repository;
	const assets = new SubtitleAssets(output, repository);
	const entry = segment(configured, media);
	const prepared = await assets.prepare(configured, guide(configured, entry));
	const snapshot = prepared.get(entry.id)![0]!.path!;
	expect(snapshot).not.toBe(oldSnapshot);
	expect(await readFile(snapshot, 'utf8')).toBe(content);
	expect(opened!.handle.fd).toBe(-1);
	expect(await readdir(directory)).toHaveLength(2);
	expect(lookup).toHaveBeenCalledOnce();
	open.mockRestore();
	expect((await assets.prepare(configured, guide(configured, entry))).get(entry.id)).toEqual([null]);
	expect(lookup).toHaveBeenCalledTimes(2);
	configured.subtitlePreferences = { policy: 'off' };
	await assets.prepare(configured, guide(configured, entry));
	expect(lookup).toHaveBeenCalledTimes(2);
});

it('closes the source and removes temporary output when streaming fails', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-sidecar-copy-failure-'));
	roots.push(root);
	const file = path.join(root, 'video.srt');
	await writeFile(file, '1\n00:00:01,000 --> 00:00:02,000\nCaption\n');
	const originalOpen = sourceFiles.openSourceFile;
	let opened: sourceFiles.OpenedSourceFile | undefined;
	vi.spyOn(sourceFiles, 'openSourceFile').mockImplementation(async (...args) => {
		opened = await originalOpen(...args);
		const originalStream = opened.handle.createReadStream.bind(opened.handle);
		vi.spyOn(opened.handle, 'createReadStream').mockImplementation((options) => {
			const stream = originalStream(options);
			stream.once('data', () => stream.destroy(new Error('fixture read failure')));
			return stream;
		});
		return opened;
	});
	const media = item();
	media.subtitleTracks = [track({ sourceType: 'sidecar', format: 'srt', streamIndex: null, playbackPaths: [file] })];
	const configured = channel();
	configured.subtitlePreferences = { policy: 'any' };
	const entry = segment(configured, media);
	const repository = { getLibraryPlaybackRoots: async () => new Map([[media.libraryId, root]]), listPrograms: async () => [], creditTemplates: { media: async () => new Map([[media.id, media]]), list: async () => [] } } as unknown as Repository;
	const assets = new SubtitleAssets(root, repository);
	expect((await assets.prepare(configured, guide(configured, entry))).get(entry.id)).toEqual([null]);
	expect(opened!.handle.fd).toBe(-1);
	expect(await readdir(path.join(root, configured.id, 'subtitles'))).toEqual([]);
});
