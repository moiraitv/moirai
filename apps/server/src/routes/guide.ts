import { sendWorkerJson, workerRequestSignal } from './worker-response.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import type { FastifyInstance } from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { MAX_TIMELINE_PREVIEW_DAYS, type GuideSegmentDetail } from '@moirai/shared';
import {
	guideSegmentDetailSchema,
	scheduleGuideSchema,
	timelineMaterializationStatusSchema,
} from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import { DuplicateTvgIdError, type EpgService } from '../guide/epg.js';
import type { Repository } from '../repository/index.js';
import {
	CommittedGuideRangeError,
	CommittedGuideUnavailableError,
	GuideMaterializationLimitError,
	readCommittedGuideAfterMaterializing,
} from '../guide/schedule-guide.js';
import type { PlaybackEngine } from '../playback/playback-engine.js';
import type { TimelineMaterializer } from '../scheduling/timeline-materializer.js';
import { parseId } from './params.js';
import {
	apiOperation,
	emptyResponseSchema,
	idParamsSchema,
	responseContent,
	textBodySchema,
} from './contracts.js';

/** Bounded local-date range accepted by committed guide endpoints. */
const guideRangeQuerySchema = z.object({
	startDate: z.iso.date().optional(),
	days: z.coerce.number().int().min(1).max(MAX_TIMELINE_PREVIEW_DAYS).optional(),
});

/** Channel and segment identifiers for committed guide detail. */
const guideSegmentParamsSchema = z.object({ channelId: z.uuid(), segmentId: z.uuid() });

/** Services required to serve guide data and XMLTV output. */
interface GuideRouteDependencies {
	playback: PlaybackEngine;
	config: AppConfig;
	repository: Repository;
	epg: EpgService;
	timelineMaterializer: TimelineMaterializer;
	schedulingWorkers: SchedulingWorkerPool;
}

/** Register committed guide, materialization, and XMLTV endpoints. */
export function registerGuideRoutes(
	app: FastifyInstance,
	{ config, repository, epg, timelineMaterializer, schedulingWorkers, playback }: GuideRouteDependencies,
): void {
	// Batch guide data for the SPA timeline views.
	app.get('/api/v1/schedule-guide', {
		schema: apiOperation({
			operationId: 'getScheduleGuide',
			tags: ['Guide'],
			summary: 'Read the committed channel guide',
			querystring: guideRangeQuerySchema,
			response: { 200: responseContent('Committed guide window', 'application/json', scheduleGuideSchema) },
			errors: [400, 422, 500, 503],
		}),
	}, async (request, reply) => {
		const query = guideRangeQuerySchema.parse(request.query);
		const startDate = query.startDate ?? Temporal.Now.plainDateISO(config.timeZone).toString();
		try {
			const result = await readCommittedGuideAfterMaterializing(
				() => schedulingWorkers.read({ kind: 'guide', timeZone: config.timeZone,
					publicUrl: config.publicUrl, startDate, guideDays: config.guideDays, days: query.days ?? config.guideDays }, workerRequestSignal(reply)),
				() => timelineMaterializer.runNow(),
			);
			return sendWorkerJson(reply, result.body);
		}
		catch (error) {
			if (
				error instanceof GuideMaterializationLimitError
				|| error instanceof CommittedGuideRangeError
			) {
				throw app.httpErrors.unprocessableEntity(error.message);
			}

			if (error instanceof CommittedGuideUnavailableError) {
				reply.header('Retry-After', '5');
				throw app.httpErrors.serviceUnavailable(error.message);
			}

			throw error;
		}
	});

	// Source and program details for one clickable guide segment.
	app.get('/api/v1/channels/:channelId/guide-segments/:segmentId', {
		schema: apiOperation({
			operationId: 'getGuideSegment',
			tags: ['Guide'],
			summary: 'Read one committed guide segment',
			params: guideSegmentParamsSchema,
			response: { 200: responseContent('Guide segment source and media detail', 'application/json', guideSegmentDetailSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const { channelId, segmentId } = guideSegmentParamsSchema.parse(request.params);
		const record = await repository.getMaterializedTimelineSegment(channelId, segmentId);
		if (!record) {
			throw app.httpErrors.notFound('Guide segment not found');
		}

		const media = record.mediaSnapshot;
		const [program, template, library, catalogItem] = await Promise.all([
			record.segment.programId ? repository.getProgram(record.segment.programId) : null,
			repository.getScheduleTemplate(record.segment.templateId),
			media ? repository.getLibrary(media.libraryId) : null,
			media ? repository.getMediaItem(media.id) : null,
		]);
		const { playbackPath: _playbackPath, ...safeSegment } = record.segment;
		void _playbackPath;
		const detail: GuideSegmentDetail = {
			segment: safeSegment,
			media: media
				? {
					id: media.id,
					libraryId: media.libraryId,
					title: media.title,
					kind: media.kind,
					durationSeconds: media.durationSeconds,
					seasonNumber: media.seasonNumber,
					episodeNumber: media.episodeNumber,
					episodeEndNumber: media.episodeEndNumber ?? null,
					genreNames: media.genreNames,
					plot: media.plot,
					year: media.year,
					artworkUrl: media.artworkUrl,
					availability: catalogItem?.availability ?? media.availability,
				}
				: null,
			catalogItemPresent: Boolean(catalogItem),
			source: {
				role: record.segment.role,
				programId: record.segment.programId,
				programName: program?.name ?? null,
				templateId: record.segment.templateId,
				templateName: template?.name ?? null,
				libraryId: media?.libraryId ?? null,
				libraryName: library?.name ?? null,
			},
		};
		return detail;
	});

	// Durable timeline health and explicit pending-change application.
	app.get('/api/v1/scheduling/materializations', {
		schema: apiOperation({
			operationId: 'listTimelineMaterializations',
			tags: ['Guide'],
			summary: 'List committed timeline health',
			response: { 200: responseContent('Channel materialization states', 'application/json', z.array(timelineMaterializationStatusSchema)) },
			errors: [500, 503],
		}),
	}, async () =>
		repository.listTimelineMaterializationStatuses());

	app.post('/api/v1/channels/:id/materialization/apply-now', {
		schema: apiOperation({
			operationId: 'applyChannelMaterialization',
			tags: ['Guide'],
			summary: 'Apply pending schedule changes now',
			params: idParamsSchema,
			response: { 202: responseContent('Updated materialization state', 'application/json', timelineMaterializationStatusSchema.nullable()) },
			errors: [400, 404, 422, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.getChannelSchedule(id))) {
			throw app.httpErrors.notFound('Channel schedule not found');
		}

		await timelineMaterializer.applyNow(id);
		const status = await repository.getTimelineMaterializationStatus(id);
		return reply.status(202).send(status);
	});

	app.post('/api/v1/channels/:id/materialization/regenerate', {
		schema: apiOperation({
			operationId: 'regenerateChannelSchedule',
			tags: ['Guide'],
			summary: 'Reset channel scheduling history and generate fresh programming',
			params: idParamsSchema,
			response: { 202: responseContent('Regenerated materialization state', 'application/json', timelineMaterializationStatusSchema.nullable()) },
			errors: [400, 404, 422, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.getChannelSchedule(id))) {
			throw app.httpErrors.notFound('Channel schedule not found');
		}

		await playback.regenerateSchedule(id, () => timelineMaterializer.regenerate(id));
		return reply.status(202).send(await repository.getTimelineMaterializationStatus(id));
	});

	// Public, cache-aware XMLTV output for IPTV clients.
	app.get('/epg.xml', {
		schema: apiOperation({
			operationId: 'getXmltvGuide',
			tags: ['IPTV delivery'],
			summary: 'Download the XMLTV guide',
			authentication: 'public',
			response: {
				200: responseContent('XMLTV guide', 'application/xml', textBodySchema),
				304: emptyResponseSchema,
			},
			errors: [422, 500, 503],
		}),
	}, async (request, reply) => {
		try {
			const document = await epg.document();
			const response = reply
				.header('Cache-Control', 'no-cache')
				.header('ETag', document.etag)
				.header('Last-Modified', new Date(document.generatedAt).toUTCString())
				.header('X-Content-Type-Options', 'nosniff');
			if (request.headers['if-none-match'] === document.etag) {
				return response.status(304).send();
			}

			return response.type('application/xml; charset=utf-8').send(document.body);
		}
		catch (error) {
			if (error instanceof GuideMaterializationLimitError || error instanceof DuplicateTvgIdError) {
				throw app.httpErrors.unprocessableEntity(error.message);
			}

			if (error instanceof CommittedGuideUnavailableError) {
				reply.header('Retry-After', '5');
				throw app.httpErrors.serviceUnavailable(error.message);
			}

			throw error;
		}
	});

}
