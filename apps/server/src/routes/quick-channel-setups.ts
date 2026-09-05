import type { FastifyInstance } from 'fastify';
import {
	catalogProgramItemFilterSchema,
	quickChannelQueryPreviewRequestSchema,
	quickChannelSetupCreateSchema,
	type SchedulingProgram,
} from '@moirai/shared';
import {
	quickChannelQueryPreviewResultSchema,
	quickChannelSetupResultSchema,
} from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { Repository } from '../repository/index.js';
import { libraryTypeMediaKind } from '../scheduling/quick-setup-resources.js';
import { registerQuickSetupPreviewRoute } from './quick-setup-preview.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import { compareLibraryQueryMedia } from '../scheduling/content-query.js';
import { schedulingContentMatches } from '../scheduling/status.js';
import { currentTimestamp } from '../time.js';
import { apiOperation, responseContent } from './contracts.js';

/** Stable synthetic identity used only while deriving a Quick Setup query preview. */
const QUICK_QUERY_PREVIEW_PROGRAM_ID = '00000000-0000-4000-8000-000000000001';

/** Services required by atomic Quick Setup creation. */
interface QuickChannelSetupRouteDependencies {
	config: AppConfig;
	repository: Repository;
	events: LiveEventHub;
	schedulingWorkers: SchedulingWorkerPool;
}

/** Register the all-in-one simple channel creation endpoint. */
export function registerQuickChannelSetupRoutes(
	app: FastifyInstance,
	{ config, repository, events, schedulingWorkers }: QuickChannelSetupRouteDependencies,
): void {
	registerQuickSetupPreviewRoute(app, { config, repository, schedulingWorkers });
	app.post('/api/v1/quick-channel-setups/query-preview', {
		schema: apiOperation({
			operationId: 'previewQuickChannelQuery',
			tags: ['Channels', 'Scheduling'],
			summary: 'Preview currently indexed media for a dynamic library query',
			body: quickChannelQueryPreviewRequestSchema,
			response: {
				200: responseContent(
					'Currently indexed query matches',
					'application/json',
					quickChannelQueryPreviewResultSchema,
				),
			},
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const input = quickChannelQueryPreviewRequestSchema.parse(request.body);
		const library = await repository.getLibrary(input.libraryId);
		if (!library) {
			throw app.httpErrors.notFound('Library not found');
		}
		if (library.typeKey !== input.scenario) {
			throw app.httpErrors.badRequest('The library is not compatible with this scenario');
		}

		const timestamp = currentTimestamp();
		const query = catalogProgramItemFilterSchema.parse(input);
		const programConfig: Extract<SchedulingProgram['config'], { type: 'content' }> = {
			type: 'content',
			source: {
				type: 'library-query',
				...query,
				libraryId: input.libraryId,
				kinds: [libraryTypeMediaKind(input.scenario)],
				sort: input.sort,
				itemLimit: input.itemLimit,
			},
			strategy: { type: 'sequential' },
		};
		const program: SchedulingProgram = {
			id: QUICK_QUERY_PREVIEW_PROGRAM_ID,
			name: 'Quick Setup query preview',
			config: programConfig,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const catalog = await repository.getSchedulingCatalog([program]);
		const orderedMatches = schedulingContentMatches(programConfig, catalog)
			.sort((left, right) => compareLibraryQueryMedia(left, right, input.sort));
		const matches = input.itemLimit === null
			? orderedMatches
			: orderedMatches.slice(0, input.itemLimit);
		const offset = input.cursor === null ? 0 : Number.parseInt(input.cursor, 10);
		if (!Number.isSafeInteger(offset) || offset > matches.length) {
			throw app.httpErrors.badRequest('The query cursor is invalid');
		}

		const end = Math.min(matches.length, offset + input.limit);
		return {
			indexedItemCount: matches.length,
			items: matches.slice(offset, end).map((media) => ({
				id: media.id,
				libraryId: media.libraryId,
				title: media.title,
				year: media.year,
				artworkUrl: media.artworkUrl,
				availability: media.availability,
			})),
			nextCursor: end < matches.length ? String(end) : null,
		};
	});

	app.post('/api/v1/quick-channel-setups', {
		schema: apiOperation({
			operationId: 'createQuickChannelSetup',
			tags: ['Channels', 'Scheduling'],
			summary: 'Create a simple playable channel and its scheduling resources',
			description:
				'Atomically creates a content program, continuous daily template, channel, and base assignment.',
			body: quickChannelSetupCreateSchema,
			response: {
				201: responseContent(
					'Created quick channel setup',
					'application/json',
					quickChannelSetupResultSchema,
				),
			},
			errors: [400, 404, 409, 422, 500, 503],
		}),
	}, async (request, reply) => {
		const input = quickChannelSetupCreateSchema.parse(request.body);
		const result = repository.createQuickChannelSetup(input, config.maxExplicitMediaItems);
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'program', change: 'created', id: result.program.id },
		});
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'template', change: 'created', id: result.template.id },
		});
		events.publish({
			type: 'scheduling.changed',
			data: { entity: 'assignment', change: 'updated', id: result.channel.id },
		});
		events.publish({
			type: 'channel.changed',
			data: { channelId: result.channel.id, change: 'created' },
		});
		return reply.status(201).send(result);
	});
}
