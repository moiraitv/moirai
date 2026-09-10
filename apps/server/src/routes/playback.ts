import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
	effectiveChannelTvgId,
	playbackSettingsSchema,
	type Channel,
} from '@moirai/shared';
import {
	hardwareAccelerationPredictionRequestSchema,
	hardwareAccelerationPredictionSchema,
	playbackEngineStatusSchema,
	playbackSettingsResponseSchema,
	clearViewingPreferencesSchema,
	viewingPreferenceListSchema,
} from '@moirai/shared/api-contracts';
import { publicChannelLogoUrl } from '../artwork/channel-logo-url.js';
import type { PlaybackEngine } from '../playback/playback-engine.js';
import type { PlaybackClientObservation } from '../playback/session-observability.js';
import type { Repository } from '../repository/index.js';
import { parseId } from './params.js';
import {
	apiOperation,
	binaryBodySchema,
	emptyResponseSchema,
	idParamsSchema,
	multiContentResponse,
	responseContent,
	textBodySchema,
} from './contracts.js';

/** Public channel number accepted by the master-playlist endpoint. */
const channelNumberParamsSchema = z.object({ number: z.string().min(1).max(32) });

/** Bounded worker-session file path parameters. */
const sessionFileParamsSchema = z.object({
	channelId: z.uuid(),
	filename: z.string().min(1).max(180),
});

/** Bounded preference-summary query. */
const viewingPreferenceQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Dependencies used by playback management and public IPTV delivery. */
interface PlaybackRouteDependencies {
	repository: Repository;
	playback: PlaybackEngine;
	publicUrl: string;
}

/** Remove control characters and quoting that could inject extra M3U attributes or rows. */
function m3uText(value: string): string {
	return value.replace(/[\r\n\t]+/gu, ' ').replaceAll('"', "'").trim();
}

/** Serialize the current channel catalog as a client-ready extended M3U playlist. */
function channelPlaylist(channels: Channel[], publicUrl: string): string {
	const lines = [
		`#EXTM3U url-tvg="${publicUrl}/epg.xml" x-tvg-url="${publicUrl}/epg.xml"`,
	];
	for (const channel of channels) {
		const logo = publicChannelLogoUrl(channel, publicUrl);
		const attributes = [
			`tvg-id="${m3uText(effectiveChannelTvgId(channel))}"`,
			`tvg-name="${m3uText(channel.name)}"`,
			`tvg-chno="${m3uText(channel.number)}"`,
			logo ? `tvg-logo="${m3uText(logo)}"` : null,
			channel.group ? `group-title="${m3uText(channel.group)}"` : null,
		].filter((value): value is string => Boolean(value));
		lines.push(`#EXTINF:0 ${attributes.join(' ')},${m3uText(channel.name)}`);
		lines.push(`${publicUrl}/iptv/channel/${encodeURIComponent(channel.number)}.m3u8`);
	}
	return `${lines.join('\n')}\n`;
}

/** Serialize the master playlist that points clients at one stable Moirai session route. */
function masterPlaylist(channel: Channel, publicUrl: string): string {
	const sessionUrl = `${publicUrl}/iptv/session/${channel.id}`;
	const bandwidth = ((channel.video.bitrateKbps ?? 4_000) + (channel.audio.bitrateKbps ?? 192)) * 1_100;
	return `#EXTM3U
#EXT-X-VERSION:6
${channel.subtitleMode === 'convert' ? `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Subtitles",DEFAULT=NO,AUTOSELECT=NO,FORCED=NO,URI="${sessionUrl}/live_sub.m3u8"\n` : ''}#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${channel.subtitleMode === 'convert' ? ',SUBTITLES="subs"' : ''}
${sessionUrl}/live.m3u8`;
}

/** Return the content type for one validated worker-generated session file. */
function sessionContentType(filename: string): string {
	if (filename.endsWith('.m3u8')) {
		return 'application/vnd.apple.mpegurl';
	}

	if (filename.endsWith('.vtt')) {
		return 'text/vtt; charset=utf-8';
	}

	return 'video/mp2t';
}

/** Capture the direct address and bounded User-Agent visible for one IPTV request. */
function playbackClient(request: FastifyRequest): PlaybackClientObservation {
	const userAgent = request.headers['user-agent'];
	return {
		address: request.ip,
		userAgent: typeof userAgent === 'string' ? userAgent : null,
	};
}

/** Register integrated playback settings, status, M3U, and HLS routes. */
export function registerPlaybackRoutes(
	app: FastifyInstance,
	{ repository, playback, publicUrl }: PlaybackRouteDependencies,
): void {
	app.get('/api/v1/playback/status', {
		schema: apiOperation({
			operationId: 'getPlaybackStatus',
			tags: ['Playback'],
			summary: 'Read playback engine status',
			response: { 200: responseContent('Playback status', 'application/json', playbackEngineStatusSchema) },
			errors: [500, 503],
		}),
	}, async (_request, reply) =>
		reply
			.header('Cache-Control', 'private, no-store')
			.send(await playback.status()));
	app.get('/api/v1/playback/settings', {
		schema: apiOperation({
			operationId: 'getPlaybackSettings',
			tags: ['Playback'],
			summary: 'Read playback settings',
			response: { 200: responseContent('Playback settings', 'application/json', playbackSettingsResponseSchema) },
			errors: [500, 503],
		}),
	}, async () => repository.getPlaybackSettings());
	app.put('/api/v1/playback/settings', {
		schema: apiOperation({
			operationId: 'updatePlaybackSettings',
			tags: ['Playback'],
			summary: 'Update playback settings',
			body: playbackSettingsSchema,
			response: { 200: responseContent('Updated playback settings', 'application/json', playbackSettingsResponseSchema) },
			errors: [400, 500, 503],
		}),
	}, async (request) =>
		playback.updateSettings(playbackSettingsSchema.parse(request.body)));
	app.get('/api/v1/viewing-preferences', {
		schema: apiOperation({
			operationId: 'listViewingPreferences',
			tags: ['Playback'],
			summary: 'List learned viewing preferences',
			querystring: viewingPreferenceQuerySchema,
			response: { 200: responseContent('Viewing preferences', 'application/json', viewingPreferenceListSchema) },
			errors: [400, 500, 503],
		}),
	}, async (request) => {
		const query = viewingPreferenceQuerySchema.parse(request.query);
		return repository.listViewingPreferences(new Date().toISOString(), query.limit);
	});
	app.post('/api/v1/viewing-preferences/clear', {
		schema: apiOperation({
			operationId: 'clearViewingPreferences',
			tags: ['Playback'],
			summary: 'Clear learned viewing preferences',
			body: clearViewingPreferencesSchema,
			response: { 204: emptyResponseSchema },
			errors: [400, 500, 503],
		}),
	}, async (request, reply) => {
		clearViewingPreferencesSchema.parse(request.body);
		repository.clearViewingPreferences();
		return reply.status(204).send();
	});
	app.post('/api/v1/playback/hardware-acceleration/predict', {
		schema: apiOperation({
			operationId: 'predictHardwareAcceleration',
			tags: ['Playback'],
			summary: 'Predict automatic channel hardware acceleration',
			body: hardwareAccelerationPredictionRequestSchema,
			response: {
				200: responseContent(
					'Automatic hardware acceleration prediction',
					'application/json',
					hardwareAccelerationPredictionSchema,
				),
			},
			errors: [400, 500, 503],
		}),
	}, async (request) => playback.predictHardwareAcceleration(
		hardwareAccelerationPredictionRequestSchema.parse(request.body),
	));
	app.post('/api/v1/playback/channels/:id/restart', {
		schema: apiOperation({
			operationId: 'restartChannelPlayback',
			tags: ['Playback'],
			summary: 'Restart one channel playback process',
			params: idParamsSchema,
			response: { 204: emptyResponseSchema },
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.getChannel(id))) {
			throw app.httpErrors.notFound('Channel not found');
		}

		await playback.restart(id);
		return reply.status(204).send();
	});

	app.get('/iptv/channels.m3u', {
		schema: apiOperation({
			operationId: 'getChannelPlaylist',
			tags: ['IPTV delivery'],
			summary: 'Download the IPTV channel playlist',
			authentication: 'public',
			response: { 200: responseContent('Extended M3U channel playlist', 'application/x-mpegurl', textBodySchema) },
			errors: [500, 503],
		}),
	}, async (_request, reply) =>
		reply
			.type('application/x-mpegurl')
			.header('Cache-Control', 'no-cache')
			.send(channelPlaylist(await repository.listChannels(), publicUrl)));

	app.get('/iptv/channel/:number.m3u8', {
		schema: apiOperation({
			operationId: 'getChannelMasterPlaylist',
			tags: ['IPTV delivery'],
			summary: 'Read a channel HLS master playlist',
			authentication: 'public',
			params: channelNumberParamsSchema,
			response: { 200: responseContent('HLS master playlist', 'application/vnd.apple.mpegurl', textBodySchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const params = channelNumberParamsSchema.parse(request.params);
		const channel = await repository.getChannelByNumber(params.number);
		if (!channel) {
			throw app.httpErrors.notFound('Channel not found');
		}

		await playback.ensureSession(channel, playbackClient(request));
		return reply
			.type('application/vnd.apple.mpegurl')
			.header('Cache-Control', 'no-cache')
			.send(masterPlaylist({ ...channel, subtitleMode: playback.subtitleMode(channel) }, publicUrl));
	});

	app.get('/iptv/session/:channelId/:filename', {
		schema: apiOperation({
			operationId: 'getPlaybackSessionFile',
			tags: ['IPTV delivery'],
			summary: 'Read a generated HLS session file',
			authentication: 'public',
			description: 'Returns a playlist, WebVTT captions, or an MPEG-TS segment based on the validated filename.',
			params: sessionFileParamsSchema,
			response: {
				200: multiContentResponse('Generated playback artifact', {
					'application/vnd.apple.mpegurl': textBodySchema,
					'text/vtt': textBodySchema,
					'video/mp2t': binaryBodySchema,
				}),
			},
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const { channelId, filename } = sessionFileParamsSchema.parse(request.params);
		let file: string;
		try {
			file = await playback.sessionFile(channelId, filename, playbackClient(request));
		}
		catch {
			throw app.httpErrors.notFound('Session file not found');
		}
		return reply
			.type(sessionContentType(filename))
			.header('Cache-Control', filename.endsWith('.m3u8') ? 'no-cache' : 'private, max-age=30')
			.header('X-Content-Type-Options', 'nosniff')
			.send(createReadStream(file));
	});
}
