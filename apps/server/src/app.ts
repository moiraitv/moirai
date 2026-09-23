import { ResponsivenessMonitor } from './operations/responsiveness.js';
import { fileURLToPath } from 'node:url';
import { EmbeddingService } from './semantic/service.js';
import { SemanticRepository } from './repository/semantic.js';
import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { validatorCompiler } from 'fastify-type-provider-zod';
import { CHANNEL_LOGO_MAX_BYTES, FALLBACK_FILLER_MAX_BYTES } from '@moirai/shared';
import { ArtworkCache } from './artwork/artwork-cache.js';
import { registerAuthenticationGuard } from './auth/http.js';
import { LogtoAuthenticationProvider } from './auth/logto-provider.js';
import { AuthenticationService } from './auth/service.js';
import { ChannelLogoStore } from './artwork/channel-logo-store.js';
import type { AppConfig } from './config.js';
import type { MoiraiDatabase } from './db/index.js';
import { EpgService } from './guide/epg.js';
import { invalidateCommittedGuideCache } from './guide/schedule-guide.js';
import { HealthService } from './operations/health-service.js';
import { LiveEventHub } from './operations/live-events.js';
import { LogService } from './operations/log-service.js';
import { MaintenanceService } from './operations/maintenance.js';
import { MediaProbe } from './media/media-probe.js';
import { PlaybackEngine } from './playback/playback-engine.js';
import { HardwareAccelerationResolver } from './playback/hardware-acceleration.js';
import { PlayoutSynchronizer } from './playback/playout-synchronizer.js';
import { FallbackFillerStore } from './playback/fallback-filler-store.js';
import { Repository } from './repository/index.js';
import { ResourcePressureCoordinator } from './operations/resource-pressure.js';
import { ScannerManager } from './scanner/manager.js';
import { OnDiskSourceAdapter } from './scanner/on-disk-adapter.js';
import { LibrarySourceRegistry } from './scanner/source-registry.js';
import { SchedulingWorkerPool } from './scheduling/worker-pool.js';
import { TimelineMaterializer } from './scheduling/timeline-materializer.js';
import { publicError } from './routes/public-errors.js';
import { suppressRoutineRequestLog } from './routes/request-logging.js';
import { registerHttpRoutes } from './routes/index.js';
import { responseSerializerCompiler } from './routes/contracts.js';

/** Long-lived services owned by one Fastify application instance. */
export interface AppServices {
	authentication: AuthenticationService;
	repository: Repository;
	scanner: ScannerManager;
	playback: PlaybackEngine;
	playout: PlayoutSynchronizer;
	events: LiveEventHub;
	artworkCache: ArtworkCache;
	channelLogos: ChannelLogoStore;
	fallbackFillers: FallbackFillerStore;
	epg: EpgService;
	timelineMaterializer: TimelineMaterializer;
	schedulingWorkers: SchedulingWorkerPool;
	logs: LogService;
	maintenance: MaintenanceService;
	mediaProbe: MediaProbe;
	resourcePressure: ResourcePressureCoordinator;
	health: HealthService;
}

/** Build the HTTP application and the services closed with it. */
export async function buildApp(
	config: AppConfig,
	db: MoiraiDatabase,
): Promise<{ app: FastifyInstance; services: AppServices }> {
	// Establish logging and the HTTP shell before constructing dependent services.
	const logs = new LogService(
		config.logDir,
		config.logLevel,
		config.logFileMaxBytes,
		config.logRetentionDays,
		config.logMaxBytes,
	);
	const app = Fastify({
		loggerInstance: logs.logger as FastifyBaseLogger,
		trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
		logController: new LogController({
			disableRequestLogging: (request) =>
				suppressRoutineRequestLog(request.method, request.url),
		}),
	});

	const responsiveness = new ResponsivenessMonitor(logs.logger);
	const requestTimings = new WeakMap<FastifyRequest, () => void>();
	app.addHook('onRequest', async (request) => {
		requestTimings.set(request, responsiveness.begin(`${request.method} ${request.routeOptions.url ?? 'unmatched'}`));
	});
	app.addHook('onResponse', async (request) => requestTimings.get(request)?.());
	app.addHook('onRequestAbort', async (request) => requestTimings.get(request)?.());
	const repository = new Repository(db);
	const authentication = new AuthenticationService(
		repository,
		config,
		logs.logger as FastifyBaseLogger,
		config.logto ? new LogtoAuthenticationProvider(config.logto) : null,
	);
	const events = new LiveEventHub((tokenHash) => authentication.sessionExpiry(tokenHash));
	const unsubscribeSessionRevocations = authentication.subscribeSessionRevocations(
		(tokenHashes, reason) => reason === 'replaced'
			? events.replaceSessions(tokenHashes)
			: events.revokeSessions(tokenHashes),
	);
	const resourcePressure = new ResourcePressureCoordinator(logs.logger);

	// Construct catalog, scanning, and media-inspection services.
	const artworkCache = new ArtworkCache(
		config.artworkCacheDir,
		config.artworkCacheMaxBytes,
		config.artworkCacheMaxEntryBytes,
		config.artworkTransformConcurrency,
	);
	const channelLogos = new ChannelLogoStore(config.channelLogoDir);

	const mediaProbe = new MediaProbe(
		config.ffprobePath,
		config.mediaProbeConcurrency,
		config.mediaProbeTimeoutMs,
		logs.logger,
		resourcePressure,
	);
	await mediaProbe.start();
	const fallbackFillers = new FallbackFillerStore(
		config.fallbackFillerDir,
		config.bundledFallbackFillerDir,
		mediaProbe,
		logs.logger as FastifyBaseLogger,
	);
	await fallbackFillers.start((await repository.listChannels()).map((channel) => channel.id));
	const librarySources = new LibrarySourceRegistry([
		new OnDiskSourceAdapter(mediaProbe),
	]);

	const scanner = new ScannerManager(
		repository,
		events,
		librarySources,
		config.scanCancellationGraceMs,
		async (libraryId, itemIds) => {
			await Promise.all(itemIds.map((id) => artworkCache.purgeOwner(libraryId, 'items', id)));
		},
		logs.logger,
		resourcePressure,
		responsiveness,
	);

	// Construct scheduling, playout, and integrated playback services.
	const schedulingWorkers = new SchedulingWorkerPool(
		config.schedulingWorkerCount,
		config.schedulingWorkerQueueLimit,
		{ db, repository, responsiveness },
	);
	const timelineMaterializer = new TimelineMaterializer(
		repository,
		events,
		config.timeZone,
		schedulingWorkers,
		undefined,
		config.guideDays,
	);
	const playout = new PlayoutSynchronizer(
		repository,
		config.playbackPlayoutDir,
		config.timeZone,
		config.playbackSyncIntervalSeconds,
		() => timelineMaterializer.runNow(),
		fallbackFillers,
		events,
		logs.logger as FastifyBaseLogger,
		schedulingWorkers,
		config.guideDays,
	);
	const hardwareAcceleration = new HardwareAccelerationResolver(
		logs.logger as FastifyBaseLogger,
	);
	const playback = new PlaybackEngine(
		repository,
		playout,
		events,
		logs.logger as FastifyBaseLogger,
		hardwareAcceleration,
		config.playbackEnginePath,
		config.playbackStreamDir,
		config.publicUrl,
		config.playbackReadyTimeoutMs,
		config.playbackStopGraceMs,
		resourcePressure,
		config.debug,
	);

	const embeddings = new EmbeddingService(new SemanticRepository(db), events, fileURLToPath(new URL('./embedding-model/', import.meta.url)));
	const unsubscribeEmbeddings = events.subscribe((event) => embeddings.handleEvent(event));

	// Register optional resource consumers in the order they should be shed.
	const unregisterPressureShedders = [
		resourcePressure.register({ name: 'semantic-embeddings', stage: 'background',
			suspend: () => embeddings.suspend(), recover: () => embeddings.resume() }),
		resourcePressure.register({
			name: 'library-watchers',
			stage: 'background',
			suspend: () => scanner.suspendWatchers(),
			recover: () => scanner.recoverWatchers(),
		}),
		resourcePressure.register({
			name: 'artwork-transforms',
			stage: 'background',
			suspend: () => artworkCache.pauseTransforms(),
			recover: () => artworkCache.resumeTransforms(),
		}),
		resourcePressure.register({
			name: 'idle-scheduling-workers',
			stage: 'background',
			suspend: () => schedulingWorkers.retireIdleWorkers(),
		}),
		resourcePressure.register({
			name: 'live-status-connections',
			stage: 'connections',
			suspend: () => events.releaseConnections(),
		}),
	];

	// Connect maintenance, guide generation, and live-event invalidation.
	const maintenance = new MaintenanceService(repository, artworkCache, logs, config, logs.logger, responsiveness);
	const epg = new EpgService(
		repository,
		config.timeZone,
		config.publicUrl,
		() => timelineMaterializer.runNow(),
		(message, extra) => logs.logger.warn(extra ?? {}, message),
		schedulingWorkers,
		config.guideDays,
	);
	const unsubscribeMaterializer = events.subscribe((event) => {
		if (event.type === 'embeddings.changed') {
			repository.invalidateSchedulingCatalog();
		}
		timelineMaterializer.handleEvent(event);
	});
	const unsubscribeEpg = events.subscribe((event) => {
		if (event.type === 'timeline.changed' || event.type === 'channel.changed' || event.type === 'scheduling.changed'
			|| event.type === 'embeddings.changed' || event.type === 'scan.changed' || event.type === 'library.changed') {
			schedulingWorkers.invalidateReads();
		}
		if (event.type === 'timeline.changed' || event.type === 'channel.changed' || event.type === 'scheduling.changed') {
			epg.invalidate();
			invalidateCommittedGuideCache();
		}
	});
	const unsubscribePlayout = events.subscribe((event) => playout.handleEvent(event));
	const unsubscribePlayback = events.subscribe((event) => {
		if (event.type === 'playback.changed' && event.data.reason === 'playout-synced' && event.data.channelId) {
			void playback.handlePlayoutChange(event.data.channelId).catch((error) => {
				logs.logger.warn({ error }, 'Playback subtitle mode update failed');
			});
		}
		if (event.type === 'channel.changed') {
			void playback.handleChannelChange(
				event.data.channelId,
				event.data.change === 'deleted',
			).catch((error) => {
				logs.logger.warn({ error, channelId: event.data.channelId }, 'Playback channel update failed');
			});
		}
	});

	const health = new HealthService(
		repository,
		scanner,
		timelineMaterializer,
		maintenance,
		playback,
		playout,
		mediaProbe,
		resourcePressure,
	);

	// Configure parsers and shared Fastify plugins before route registration.
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);
	app.addContentTypeParser(
		'image/png',
		{ parseAs: 'buffer', bodyLimit: CHANNEL_LOGO_MAX_BYTES },
		(_request, body, done) => done(null, body),
	);

	await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
	await app.register(sensible);
	await app.register(cookie);
	await app.register(formbody);
	await app.register(multipart, {
		limits: { files: 1, fields: 0, fileSize: FALLBACK_FILLER_MAX_BYTES },
		throwFileSizeLimit: true,
	});
	registerAuthenticationGuard(app, authentication, config);

	// Start and stop background services with the HTTP application lifecycle.
	app.addHook('onReady', async () => {
		await authentication.start();
		if (!(await repository.authentication.initialized())) {
			logs.logger.warn(
				{ setupUrl: `${config.managementUrl}/setup` },
				'Authentication is uninitialized; the first visitor can claim administrator access',
			);
		}
		embeddings.start();
		timelineMaterializer.start();
		playout.start();
		await playback.start();
		maintenance.start();
	});
	app.addHook('onClose', async () => {
		responsiveness.close();
		authentication.close();
		unsubscribeSessionRevocations();
		unsubscribeMaterializer();
		unsubscribeEmbeddings();
		await embeddings.close();
		unsubscribeEpg();
		unsubscribePlayout();
		unsubscribePlayback();
		await playback.close();
		await playout.close();
		await timelineMaterializer.close();
		await schedulingWorkers.close();
		await maintenance.close();
		await mediaProbe.close();
		unregisterPressureShedders.forEach((unregister) => unregister());
		await resourcePressure.close();
		events.close();
		await logs.close();
	});

	// Convert all handler failures through the stable public error contract.
	app.setErrorHandler((error, request, reply) => {
		const mapped = publicError(error, request.id);
		request.log[mapped.expected ? 'warn' : 'error']({ err: error }, mapped.body.message);
		if (mapped.retryAfter) {
			reply.header('Retry-After', mapped.retryAfter);
		}
		reply.status(mapped.statusCode).send(mapped.body);
	});

	// Register API domains after their shared dependencies are ready.
	registerHttpRoutes(app, {
		requestEmbeddingWork: (includeMedia) => embeddings.requestPreferences(includeMedia),
		playout,
		config,
		authentication,
		repository,
		scanner,
		playback,
		events,
		artworkCache,
		channelLogos,
		fallbackFillers,
		epg,
		timelineMaterializer,
		schedulingWorkers,
		logs,
		health,
	});

	// Serve the built SPA last so it cannot shadow API routes.
	if (existsSync(config.webDistDir)) {
		await app.register(fastifyStatic, { root: config.webDistDir });
		app.setNotFoundHandler((request, reply) => {
			if (request.url.startsWith('/api/')) {
				return reply
					.status(404)
					.send({ code: 'not_found', message: 'Route not found', requestId: request.id });
			}
			if (request.url.startsWith('/help/')) {
				return reply.status(404).sendFile('help/404.html');
			}

			return reply.sendFile('index.html');
		});
	}

	return {
		app,
		services: {
			authentication,
			repository,
			scanner,
			playback,
			playout,
			events,
			artworkCache,
			channelLogos,
			fallbackFillers,
			epg,
			timelineMaterializer,
			schedulingWorkers,
			logs,
			maintenance,
			mediaProbe,
			resourcePressure,
			health,
		},
	};
}
