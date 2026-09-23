import { timePhase, timeAsyncPhase } from '../scheduling/job-timing.js';
import { createHash } from 'node:crypto';
import { scheduleGuideSchema } from '@moirai/shared/api-contracts';
import { guideTemplatePreviewResultSchema, type GuideTemplatePreview, XMLTV_EPG_DAYS } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import { readCommittedScheduleGuide, readCommittedChannelScheduleGuide } from './schedule-guide.js';
import { buildXmltv, presentGuideListings, previewGuideListings } from './epg.js';
import { currentTimestamp } from '../time.js';

/** Committed guide reads never generate or commit programming inside their worker. */
export interface GuideReadRequest {
	kind: 'guide' | 'xmltv' | 'guide-template' | 'channel-guide';
	channelId?: string;
	preview?: GuideTemplatePreview;
	timeZone: string;
	publicUrl: string;
	startDate: string;
	days: number;
	guideDays?: number;
}

/** Complete response bytes and metadata, with bounded template warnings for the main logger. */
export interface GuideReadResult {
	body: string;
	etag?: string;
	startDate?: string;
	generatedAt?: string;
	warnings?: Array<{ message: string; extra?: Record<string, unknown> }>;
}

/** Read authoritative timelines, present them, and serialize without exposing catalog objects. */
export async function guideRead(repository: Repository, request: GuideReadRequest, readComplete = (): void => {}): Promise<GuideReadResult> {
	if (request.kind === 'channel-guide') {
		const guide = await timeAsyncPhase('read', () => readCommittedChannelScheduleGuide(
			repository,
			request.timeZone,
			request.channelId!,
			request.startDate,
			request.days,
			request.guideDays,
		));
		readComplete();
		return timePhase('serialize', () => {
			scheduleGuideSchema.parse(guide);
			return { body: JSON.stringify(guide) };
		});
	}

	const [channels, materialized, templates] = await timeAsyncPhase('read', () => Promise.all([
		repository.listChannels(),
		readCommittedScheduleGuide(
			repository,
			request.timeZone,
			request.startDate,
			request.days,
			{ includeMediaCatalog: true, guideDays: request.guideDays ?? XMLTV_EPG_DAYS },
		),
		repository.guideTemplates.sourcesById(),
	]));
	readComplete();
	if (request.kind === 'guide-template') {
		const channel = channels.find(value => value.id === request.preview!.channelId);
		if (!channel) {
			throw Object.assign(new Error('Channel not found'), { statusCode: 404, expose: true });
		}
		const preview = await timeAsyncPhase('compute', () => previewGuideListings(
			channel,
			materialized.guide,
			materialized.catalog,
			request.publicUrl,
			request.preview!.sources,
		));
		return timePhase('serialize', () => {
			const value = { timeZone: materialized.guide.timeZone, startDate: materialized.guide.startDate, ...preview };
			guideTemplatePreviewResultSchema.parse(value);
			return { body: JSON.stringify(value) };
		});
	}
	const warnings: NonNullable<GuideReadResult['warnings']> = [];
	const options = {
		sourcesForChannel: (channel: typeof channels[number]) => channel.guideTemplateId
			? templates.byId.get(channel.guideTemplateId) ?? templates.defaultSources : templates.defaultSources,
		fallback: true,
		warn: (message: string, extra?: Record<string, unknown>) => {
			if (warnings.length < 10) {
				warnings.push({ message, ...(extra ? { extra } : {}) });
			}
		},
	};
	if (request.kind === 'xmltv') {
		const body = await timeAsyncPhase('compute', () => buildXmltv(
			channels.filter(channel => channel.enabled !== false),
			materialized.guide,
			materialized.catalog,
			request.publicUrl,
			{ ...options, minify: true },
		));
		return { body, etag: `"${createHash('sha256').update(body).digest('hex')}"`,
			startDate: request.startDate, generatedAt: currentTimestamp(), warnings };
	}

	const value = await timeAsyncPhase('compute', () => presentGuideListings(channels, materialized.guide, materialized.catalog, request.publicUrl, options));
	return timePhase('serialize', () => {
		scheduleGuideSchema.parse(value);
		return { body: JSON.stringify(value), warnings };
	});
}
