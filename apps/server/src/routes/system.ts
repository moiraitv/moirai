import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ETV_CONTRACT_REVISION } from '@moirai/ersatztv-contract';
import { LIBRARY_TYPE_KEYS, MEDIA_EXTENSIONS } from '@moirai/shared';
import {
	appCapabilitiesSchema,
	dataConflictReportSchema,
	livenessSchema,
	logFileSchema,
	logPageSchema,
	readinessSchema,
	startupStatusSchema,
} from '@moirai/shared/api-contracts';
import type { AppConfig } from '../config.js';
import { authenticatedSession } from '../auth/http.js';
import { publicUrlStatus } from '../config.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { LogService } from '../operations/log-service.js';
import type { HealthService } from '../operations/health-service.js';
import type { Repository } from '../repository/index.js';
import type { ScannerManager } from '../scanner/manager.js';
import {
	apiOperation,
	binaryBodySchema,
	emptyResponseSchema,
	responseContent,
} from './contracts.js';

/** Bounded filters accepted by the operational log viewer. */
const logQuerySchema = z.object({
	cursor: z.string().max(16_384).optional(),
	level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
	search: z.string().trim().max(200).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** Retained log filename accepted by the download endpoint. */
const logFileParamsSchema = z.object({ name: z.string().min(1).max(180) });

/** Services required by health, status, event, and log routes. */
interface SystemRouteDependencies {
	config: AppConfig;
	events: LiveEventHub;
	logs: LogService;
	health: HealthService;
	repository: Repository;
	scanner: ScannerManager;
}

/** Register health, capability, live-event, and operational-log endpoints. */
export function registerSystemRoutes(
	app: FastifyInstance,
	{ config, events, logs, health, repository, scanner }: SystemRouteDependencies,
): void {
	app.route({
		method: 'GET',
		url: '/api/v1/events',
		schema: apiOperation({
			operationId: 'connectLiveEvents',
			tags: ['System'],
			summary: 'Connect to live status events',
			description: 'Upgrades to WebSocket. Message payloads are defined by the generated AsyncAPI contract.',
			response: { 101: responseContent('WebSocket connection established', 'application/octet-stream', emptyResponseSchema) },
			errors: [400, 403, 500, 503],
		}),
		handler: async () => {
			throw app.httpErrors.badRequest('WebSocket upgrade is required');
		},
		wsHandler: (socket, request) => events.attach(socket, authenticatedSession(request)),
	});
	app.get('/api/v1/health', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'getHealth',
			tags: ['System'],
			summary: 'Check process liveness',
			authentication: 'public',
			description: 'Compatibility alias for the lightweight liveness check.',
			response: { 200: responseContent('Process is alive', 'application/json', livenessSchema) },
		}),
	}, async () => ({ status: 'ok' }));
	app.get('/api/v1/health/live', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'getLiveness',
			tags: ['System'],
			summary: 'Check process liveness',
			authentication: 'public',
			response: { 200: responseContent('Process is alive', 'application/json', livenessSchema) },
		}),
	}, async () => ({ status: 'ok' }));
	app.get('/api/v1/health/startup', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'getStartup',
			tags: ['System'],
			summary: 'Check database migration startup',
			authentication: 'public',
			description: 'Reports migration progress during bootstrap and ready after the application is up.',
			response: {
				200: responseContent('Startup or migration status', 'application/json', startupStatusSchema),
			},
		}),
	}, async () => ({
		status: 'ready' as const,
		applied: 0,
		total: 0,
		percent: 100,
	}));
	app.get('/api/v1/health/ready', {
		config: { authentication: 'public' },
		schema: apiOperation({
			operationId: 'getReadiness',
			tags: ['System'],
			summary: 'Check service readiness',
			authentication: 'public',
			description: 'Returns 503 only when SQLite or the playback engine cannot serve. Background services report as non-blocking degraded checks.',
			response: {
				200: responseContent('Essential services are ready', 'application/json', readinessSchema),
				503: responseContent('An essential service is degraded', 'application/json', readinessSchema),
			},
			errors: [500],
		}),
	}, async (_request, reply) => {
		const status = await health.readiness();
		return reply.status(status.status === 'ready' ? 200 : 503).send(status);
	});
	app.get('/api/v1/capabilities', {
		schema: apiOperation({
			operationId: 'getCapabilities',
			tags: ['System'],
			summary: 'Read server capabilities',
			response: { 200: responseContent('Configured server capabilities', 'application/json', appCapabilitiesSchema) },
		}),
	}, async () => ({
		libraryTypes: LIBRARY_TYPE_KEYS,
		sourceTypes: scanner.sourceTypes,
		mediaExtensions: MEDIA_EXTENSIONS,
		etvContractRevision: ETV_CONTRACT_REVISION,
		authentication: 'session',
		timeZone: config.timeZone,
		guideDays: config.guideDays,
		publicUrl: config.publicUrl,
		publicUrlStatus: publicUrlStatus(config.publicUrl),
		maxExplicitMediaItems: config.maxExplicitMediaItems,
	}));
	app.get('/api/v1/status/conflicts', {
		schema: apiOperation({
			operationId: 'listDataConflicts',
			tags: ['System'],
			summary: 'List data identity conflicts',
			response: { 200: responseContent('Bounded conflict report', 'application/json', dataConflictReportSchema) },
			errors: [500, 503],
		}),
	}, async () => repository.listDataConflicts());

	app.get('/api/v1/logs', {
		schema: apiOperation({
			operationId: 'listLogs',
			tags: ['Logs'],
			summary: 'Read operational logs',
			querystring: logQuerySchema,
			response: { 200: responseContent('Retained log entries', 'application/json', logPageSchema) },
			errors: [400, 500, 503],
		}),
	}, async (request) => {
		const query = logQuerySchema.parse(request.query);
		try {
			return await logs.page(query);
		}
		catch (error) {
			if (error instanceof Error && error.message === 'Invalid log cursor') {
				throw app.httpErrors.badRequest('Invalid log cursor');
			}

			throw error;
		}
	});
	app.get('/api/v1/logs/files', {
		schema: apiOperation({
			operationId: 'listLogFiles',
			tags: ['Logs'],
			summary: 'List retained log files',
			response: { 200: responseContent('Retained log files', 'application/json', z.array(logFileSchema)) },
			errors: [500, 503],
		}),
	}, async () => logs.files());
	app.get('/api/v1/logs/files/:name', {
		schema: apiOperation({
			operationId: 'downloadLogFile',
			tags: ['Logs'],
			summary: 'Download a retained log file',
			params: logFileParamsSchema,
			response: { 200: responseContent('NDJSON log stream', 'application/x-ndjson', binaryBodySchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const name = logFileParamsSchema.parse(request.params).name;
		const stream = await logs.download(name);
		if (!stream) {
			throw app.httpErrors.notFound('Log file not found');
		}

		return reply
			.type('application/x-ndjson')
			.header('Content-Disposition', `attachment; filename="${name}"`)
			.header('X-Content-Type-Options', 'nosniff')
			.send(stream);
	});
}
