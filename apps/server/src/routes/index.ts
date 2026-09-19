import { registerResourceUsageRoutes } from './resource-usage.js';
import { registerEncodingProfileRoutes } from './encoding-profiles.js';
import { registerCreditTemplateRoutes } from './credit-templates.js';
import { registerGuideTemplateRoutes } from './guide-templates.js';
import type { PlayoutSynchronizer } from '../playback/playout-synchronizer.js';
import type { FastifyInstance } from 'fastify';
import type { ArtworkCache } from '../artwork/artwork-cache.js';
import type { AuthenticationService } from '../auth/service.js';
import type { ChannelLogoStore } from '../artwork/channel-logo-store.js';
import type { AppConfig } from '../config.js';
import type { EpgService } from '../guide/epg.js';
import type { HealthService } from '../operations/health-service.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { LogService } from '../operations/log-service.js';
import type { PlaybackEngine } from '../playback/playback-engine.js';
import type { FallbackFillerStore } from '../playback/fallback-filler-store.js';
import type { Repository } from '../repository/index.js';
import type { ScannerManager } from '../scanner/manager.js';
import type { SchedulingWorkerPool } from '../scheduling/worker-pool.js';
import type { TimelineMaterializer } from '../scheduling/timeline-materializer.js';
import { registerCatalogRoutes } from './catalog.js';
import { registerAuthenticationRoutes } from './authentication.js';
import { registerChannelRoutes } from './channels.js';
import { registerGuideRoutes } from './guide.js';
import { registerFallbackFillerRoutes } from './fallback-fillers.js';
import { registerLibraryRoutes } from './libraries.js';
import { registerPlaybackRoutes } from './playback.js';
import { registerQuickChannelSetupRoutes } from './quick-channel-setups.js';
import { registerSchedulingRoutes } from './scheduling.js';
import { registerSystemRoutes } from './system.js';

/** Services captured by HTTP handlers after route registration. */
export interface HttpRouteDependencies {
	config: AppConfig;
	playout: PlayoutSynchronizer;
	authentication: AuthenticationService;
	repository: Repository;
	scanner: ScannerManager;
	playback: PlaybackEngine;
	events: LiveEventHub;
	artworkCache: ArtworkCache;
	channelLogos: ChannelLogoStore;
	fallbackFillers: FallbackFillerStore;
	epg: EpgService;
	timelineMaterializer: TimelineMaterializer;
	schedulingWorkers: SchedulingWorkerPool;
	logs: LogService;
	health: HealthService;
}

/** Register the complete documented HTTP and WebSocket route surface. */
export function registerHttpRoutes(
	app: FastifyInstance,
	dependencies: HttpRouteDependencies,
): void {
	registerAuthenticationRoutes(app, dependencies.config, dependencies.authentication);
	registerSystemRoutes(app, dependencies);
	registerResourceUsageRoutes(app, dependencies);
	registerCreditTemplateRoutes(app, dependencies);
	registerGuideTemplateRoutes(app, dependencies);
	registerEncodingProfileRoutes(app, dependencies);
	registerLibraryRoutes(app, dependencies);
	registerCatalogRoutes(app, dependencies);
	registerChannelRoutes(app, dependencies);
	registerQuickChannelSetupRoutes(app, dependencies);
	registerFallbackFillerRoutes(app, dependencies);
	registerSchedulingRoutes(app, dependencies);
	registerGuideRoutes(app, dependencies);
	registerPlaybackRoutes(app, {
		repository: dependencies.repository,
		playback: dependencies.playback,
		publicUrl: dependencies.config.publicUrl,
	});
}
