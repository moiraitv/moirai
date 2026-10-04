import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { responseSerializerCompiler } from '@server/routes/contracts.js';
import { publicError } from '@server/routes/public-errors.js';
import { describe, expect, it, vi } from 'vitest';
import { MAX_SUBTITLE_PREVIEW_ANCESTORS, subtitleSelectionPreviewSchema, subtitleSelectionPreviewResultSchema, type MediaItem, type MediaSubtitleTrack, type SubtitlePreferences } from '@moirai/shared';
import { previewSubtitleSelection } from '@server/playback/subtitle-preview.js';
import { selectSubtitle } from '@server/playback/subtitle-selection.js';
import { registerSubtitlePreviewRoutes } from '@server/routes/subtitle-preview.js';
import type { Repository } from '@server/repository/index.js';

function track(overrides: Partial<MediaSubtitleTrack> = {}): MediaSubtitleTrack {
	return { id: randomUUID(), sourceType: 'embedded', partNumber: 1, streamIndex: 3, codec: 'ass', format: null,
		language: 'eng', title: null, isDefault: false, isForced: false, isHearingImpaired: false, isCommentary: false,
		relativePaths: [], playbackPaths: [], ...overrides };
}
function item(tracks: MediaSubtitleTrack[]): MediaItem {
	// Selection reads only identity, kind, parts, and the indexed inventory.
	return { id: randomUUID(), title: 'Sample anime', kind: 'episode', parts: [], subtitleTracks: tracks } as unknown as MediaItem;
}
function preview(media: MediaItem, preferences: SubtitlePreferences) {
	return previewSubtitleSelection(media, { mediaItemId: media.id, channelPreferences: preferences, programPreferences: [] });
}

describe('metadata subtitle selection preview', () => {
	it('matches playback for both sample inventories without interpreting names as flags', () => {
		const neptunia = item([track({ streamIndex: 5, title: 'Dialog', codec: 'hdmv_pgs_subtitle' }), track({ streamIndex: 6, title: 'Songs & Signs', codec: 'hdmv_pgs_subtitle', isDefault: true, isForced: true })]);
		const kimi = item([track({ isDefault: true, isForced: true }), track({ streamIndex: 4, title: 'Forced' }), track({ streamIndex: 5, title: 'CC', codec: 'subrip' })]);
		for (const media of [neptunia, kimi]) {
			for (const preferences of [{ policy: 'any', language: 'en' }, { policy: 'default' }, { policy: 'any', title: 'forced' }, { policy: 'forced', title: 'Forced' }, { policy: 'any', title: 'Signs' }, { policy: 'off' }] as SubtitlePreferences[]) {
				const result = preview(media, preferences);
				expect(result.parts[0]!.selectedTrackId).toBe(selectSubtitle(media.subtitleTracks, preferences, 1)?.id ?? null);
				expect(subtitleSelectionPreviewResultSchema.safeParse(result).success).toBe(true);
			}
		}
		expect(preview(kimi, { policy: 'forced', title: 'Forced' }).parts[0]!.tracks[1]!.rejectionReasons).toContain('forced');
		expect(preview(neptunia, { policy: 'any', title: 'Songs.*' }).parts[0]!.outcome).toBe('no-match');
	});
	it('reports all failed constraints, preserves aliases, and ranks duplicate records once per part', () => {
		const signs = track({ title: 'Signs', isDefault: true });
		const dialogue = track({ streamIndex: 4, title: 'Signs' });
		const foreign = track({ streamIndex: 5, partNumber: 2, language: 'fra', title: null });
		const media = item([dialogue, signs, { ...signs }, foreign]);
		media.parts = [1, 2].map(number => ({ number, kind: null, relativePath: '', playbackPath: '', durationSeconds: 1, subtitleTracks: [signs] }));
		const result = preview(media, { policy: 'default', language: 'en', title: 'sIgNs' });
		expect(result.parts[0]!.selectedTrackId).toBe(signs.id);
		expect(result.parts[0]!.tracks.filter(entry => entry.track.id === signs.id)).toHaveLength(1);
		expect(result.parts[1]!.outcome).toBe('no-match');
		expect(preview(media, { policy: 'forced', language: 'eng', title: 'Signs' }).parts[0]!.tracks.find(entry => entry.track.id === foreign.id)!.rejectionReasons).toEqual(['part', 'language', 'title', 'forced']);
		foreign.partNumber = null;
		expect(preview(media, { policy: 'any', language: 'fre' }).parts.map(part => part.selectedTrackId)).toEqual([foreign.id, foreign.id]);
	});
	it('resolves outer and inner drafts independently, with explicit null clearing and credits priority', () => {
		const media = item([track({ title: 'Dialog' })]);
		const result = previewSubtitleSelection(media, { mediaItemId: media.id, channelPreferences: { policy: 'default', language: 'en', title: 'Signs' }, programPreferences: [{ policy: 'any', title: 'Forced' }, { title: null }] });
		expect(result.preferences).toEqual({ policy: 'any', language: 'en', title: null });
		expect(result.parts[0]!.selectedTrackId).toBe(media.subtitleTracks[0]!.id);
		media.kind = 'music-video';
		const credits = preview(media, { policy: 'off', creditsTemplateId: randomUUID() });
		expect(credits.parts[0]).toMatchObject({ outcome: 'credits', selectedTrackId: null });
	});
	it('keeps file paths private and qualifies VobSub metadata without probing', () => {
		const media = item([track({ sourceType: 'sidecar', format: 'vobsub', playbackPaths: ['/private/example.idx'] })]);
		const result = preview(media, { policy: 'any' });
		expect(result.limitations).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain('/private');
	});
	it('bounds authored contexts and rejects incomplete specific rules', () => {
		const input = { mediaItemId: randomUUID(), channelPreferences: {}, programPreferences: Array.from({ length: MAX_SUBTITLE_PREVIEW_ANCESTORS + 1 }, () => ({})) };
		expect(subtitleSelectionPreviewSchema.safeParse(input).success).toBe(true);
		expect(subtitleSelectionPreviewSchema.safeParse({ ...input, programPreferences: [...input.programPreferences, {}] }).success).toBe(false);
		expect(subtitleSelectionPreviewSchema.safeParse({ ...input, channelPreferences: { title: '' } }).success).toBe(false);
	});
	it('serves the documented operation with only the chosen metadata lookup and handles deleted media', async () => {
		const media = item([track({ title: 'Forced' })]);
		const lookup = vi.fn(async () => new Map([[media.id, media]]));
		const app = Fastify();
		app.setValidatorCompiler(validatorCompiler);
		app.setSerializerCompiler(responseSerializerCompiler);
		app.setErrorHandler((error, request, reply) => {
			const mapped = publicError(error, request.id);
			void reply.code(mapped.statusCode).send(mapped.body);
		});
		await app.register(sensible);
		registerSubtitlePreviewRoutes(app, { repository: { creditTemplates: { media: lookup } } as unknown as Repository });
		try {
			const body = { mediaItemId: media.id, channelPreferences: { policy: 'any', title: 'Forced' }, programPreferences: [] };
			const response = await app.inject({ method: 'POST', url: '/api/v1/subtitles/selection-preview', payload: body });
			expect(response.statusCode).toBe(200);
			expect(response.json().parts[0].selectedTrackId).toBe(media.subtitleTracks[0]!.id);
			expect(lookup).toHaveBeenCalledExactlyOnceWith([media.id]);
			const invalid = await app.inject({ method: 'POST', url: '/api/v1/subtitles/selection-preview', payload: { ...body, channelPreferences: { title: '' } } });
			expect(invalid.statusCode).toBe(400);
			expect(lookup).toHaveBeenCalledTimes(1);
			lookup.mockResolvedValueOnce(new Map());
			expect((await app.inject({ method: 'POST', url: '/api/v1/subtitles/selection-preview', payload: body })).statusCode).toBe(404);
		}
		finally {
			await app.close();
		}
	});
});
