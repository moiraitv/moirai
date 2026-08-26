import type { MaintenanceService } from './maintenance.js';
import type { PlaybackEngine } from '../playback/playback-engine.js';
import type { PlayoutSynchronizer } from '../playback/playout-synchronizer.js';
import type { Repository } from '../repository/index.js';
import type { ScannerManager } from '../scanner/manager.js';
import type { TimelineMaterializer } from '../scheduling/timeline-materializer.js';
import type { MediaProbe } from '../media/media-probe.js';
import type { ResourcePressureCoordinator } from './resource-pressure.js';

/** One readiness dependency and whether it can block authoritative output. */
export interface ReadinessCheck {
	name:
		| 'database'
		| 'scanner'
		| 'timeline'
		| 'maintenance'
		| 'playbackEngine'
		| 'playoutSync'
		| 'mediaProbe'
		| 'resourcePressure'
		| 'mediaSources';
	status: 'ready' | 'degraded' | 'disabled';
	essential: boolean;
	detail?: string;
}

/** Readiness result returned by the operational health endpoint. */
export interface ReadinessStatus {
	status: 'ready' | 'degraded';
	checks: ReadinessCheck[];
}

/**
 * Build operational readiness from lightweight process and persisted service state. The aggregator
 * avoids traversing source file trees and distinguishes failures that block authoritative output from
 * degraded context that operators should still see.
 */
export class HealthService {
	constructor(
		private readonly repository: Repository,
		private readonly scanner: ScannerManager,
		private readonly timelineMaterializer: TimelineMaterializer,
		private readonly maintenance: MaintenanceService,
		private readonly playbackEngine: PlaybackEngine,
		private readonly playoutSync: PlayoutSynchronizer,
		private readonly mediaProbe?: MediaProbe,
		private readonly resourcePressure?: ResourcePressureCoordinator,
	) {}

	/** Evaluate the database, essential workers, committed timelines, and source warnings. */
	async readiness(): Promise<ReadinessStatus> {
		// Verify SQLite first because later checks may need persisted status.
		const checks: ReadinessCheck[] = [];
		let databaseReady = true;
		try {
			this.repository.checkDatabase();
			checks.push({ name: 'database', status: 'ready', essential: true });
		}
		catch {
			databaseReady = false;
			checks.push({
				name: 'database',
				status: 'degraded',
				essential: true,
				detail: 'SQLite is unavailable',
			});
		}

		// Check active ingestion and resource-pressure services.
		const scanner = this.scanner.health();
		checks.push({
			name: 'scanner',
			status: scanner.status === 'ready' ? 'ready' : 'degraded',
			essential: true,
			...(scanner.status === 'ready'
				? {}
				: { detail: scanner.detail ?? `Scanner is ${scanner.status}` }),
		});
		if (this.mediaProbe) {
			const mediaProbe = this.mediaProbe.health();
			checks.push({
				name: 'mediaProbe',
				status: mediaProbe.status === 'ready' ? 'ready' : 'degraded',
				essential: true,
				...(mediaProbe.status === 'ready'
					? {}
					: { detail: mediaProbe.detail ?? `Media probe is ${mediaProbe.status}` }),
			});
		}
		if (this.resourcePressure) {
			const pressure = this.resourcePressure.health();
			checks.push({
				name: 'resourcePressure',
				status: pressure.status === 'ready' ? 'ready' : 'degraded',
				essential: false,
				...(pressure.detail ? { detail: pressure.detail } : {}),
			});
		}

		// Combine materializer process health with persisted per-channel failures.
		const timeline = this.timelineMaterializer.health();
		let timelineCheck: ReadinessCheck = {
			name: 'timeline',
			status: timeline.status,
			essential: true,
			...(timeline.detail ? { detail: timeline.detail } : {}),
		};
		if (databaseReady && timelineCheck.status === 'ready') {
			try {
				const failed = (await this.repository.listTimelineMaterializationStatuses())
					.filter((entry) => entry.health === 'failed').length;
				if (failed > 0) {
					timelineCheck = {
						...timelineCheck,
						status: 'degraded',
						detail: `${failed} channel timeline${failed === 1 ? '' : 's'} failed to materialize`,
					};
				}
			}
			catch {
				timelineCheck = {
					...timelineCheck,
					status: 'degraded',
					detail: 'Timeline status could not be read',
				};
			}
		}
		checks.push(timelineCheck);

		// Check the remaining essential background and playback services.
		const maintenance = this.maintenance.health();
		checks.push({ name: 'maintenance', essential: true, ...maintenance });
		checks.push({ name: 'playbackEngine', essential: true, ...this.playbackEngine.health() });
		checks.push({ name: 'playoutSync', essential: true, ...this.playoutSync.health() });

		// Report media-source problems as degraded context rather than failed readiness.
		if (databaseReady) {
			try {
				const libraries = await this.repository.listLibraries();
				const affected = libraries.filter(
					(library) =>
						library.enabled
						&& (library.sourceAvailability !== 'available' || library.watcherStatus === 'error'),
				).length;
				checks.push(
					affected === 0
						? { name: 'mediaSources', status: 'ready', essential: false }
						: {
							name: 'mediaSources',
							status: 'degraded',
							essential: false,
							detail: `${affected} enabled media source${affected === 1 ? '' : 's'} need attention`,
						},
				);
			}
			catch {
				checks.push({
					name: 'mediaSources',
					status: 'degraded',
					essential: false,
					detail: 'Media source health could not be read',
				});
			}
		}

		// Only degraded essential checks make the instance unready.
		return {
			status: checks.some((check) => check.essential && check.status === 'degraded')
				? 'degraded'
				: 'ready',
			checks,
		};
	}
}
