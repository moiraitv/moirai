import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HealthService } from '@server/operations/health-service.js';
import type { MaintenanceService } from '@server/operations/maintenance.js';
import type { PlaybackEngine } from '@server/playback/playback-engine.js';
import type { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';
import type { Repository } from '@server/repository/index.js';
import type { ScannerManager } from '@server/scanner/manager.js';
import type { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';
import type { MediaProbe } from '@server/media/media-probe.js';

/** Process health snapshot used by readiness fixtures. */
type ProcessHealth = { status: 'ready' | 'degraded'; detail?: string };

/** Build health dependencies with ready process services and no persisted failures. */
function fixture(overrides: {
	libraries?: unknown[];
	databaseError?: boolean;
	playback?: ProcessHealth;
	scanner?: ProcessHealth;
	timeline?: ProcessHealth;
	maintenance?: ProcessHealth;
	playout?: ProcessHealth;
	mediaProbe?: ProcessHealth;
	failedTimelines?: number;
} = {}): HealthService {
	const repository = {
		checkDatabase: overrides.databaseError
			? vi.fn(() => {
				throw new Error('database unavailable');
			})
			: vi.fn(),
		listTimelineMaterializationStatuses: vi.fn().mockResolvedValue(
			Array.from({ length: overrides.failedTimelines ?? 0 }, () => ({
				channelId: randomUUID(),
				health: 'failed',
				windowStart: null,
				windowEnd: null,
				pendingSince: null,
				applyAfter: null,
				lastError: 'generation failed',
				committedAt: null,
			})),
		),
		listLibraries: vi.fn().mockResolvedValue(overrides.libraries ?? []),
	} as unknown as Repository;
	const scanner = {
		health: () => overrides.scanner ?? { status: 'ready' as const },
	} as unknown as ScannerManager;
	const timeline = {
		health: () => overrides.timeline ?? { status: 'ready' as const },
	} as unknown as TimelineMaterializer;
	const maintenance = {
		health: () => overrides.maintenance ?? { status: 'ready' as const },
	} as unknown as MaintenanceService;
	const playback = {
		health: () => overrides.playback ?? { status: 'ready' as const },
	} as unknown as PlaybackEngine;
	const playout = {
		health: () => overrides.playout ?? { status: 'ready' as const },
	} as unknown as PlayoutSynchronizer;
	const mediaProbe = overrides.mediaProbe
		? { health: () => overrides.mediaProbe } as unknown as MediaProbe
		: undefined;
	return new HealthService(
		repository,
		scanner,
		timeline,
		maintenance,
		playback,
		playout,
		mediaProbe,
	);
}

describe('HealthService', () => {
	it('reports unavailable media sources without failing process readiness', async () => {
		const health = fixture({
			libraries: [{
				enabled: true,
				sourceAvailability: 'unavailable',
				watcherStatus: 'error',
			}],
		});

		await expect(health.readiness()).resolves.toMatchObject({
			status: 'ready',
			checks: expect.arrayContaining([
				expect.objectContaining({
					name: 'mediaSources',
					status: 'degraded',
					essential: false,
				}),
			]),
		});
	});

	it('fails readiness when the integrated playback engine is unavailable', async () => {
		const health = fixture({
			playback: { status: 'degraded', detail: 'Engine unavailable' },
		});

		await expect(health.readiness()).resolves.toMatchObject({
			status: 'degraded',
			checks: expect.arrayContaining([
				expect.objectContaining({
					name: 'playbackEngine',
					status: 'degraded',
					essential: true,
				}),
			]),
		});
	});

	it('fails readiness when SQLite is unavailable', async () => {
		const health = fixture({ databaseError: true });

		await expect(health.readiness()).resolves.toMatchObject({
			status: 'degraded',
			checks: expect.arrayContaining([
				expect.objectContaining({
					name: 'database',
					status: 'degraded',
					essential: true,
				}),
			]),
		});
	});

	it('reports background and per-channel failures without failing process readiness', async () => {
		const health = fixture({
			scanner: { status: 'degraded', detail: 'Scanner startup failed' },
			mediaProbe: { status: 'degraded', detail: 'ffprobe is unavailable' },
			maintenance: { status: 'degraded', detail: 'Operational maintenance is not running' },
			playout: { status: 'degraded', detail: '1 channel playout could not be synchronized' },
			failedTimelines: 1,
		});

		await expect(health.readiness()).resolves.toMatchObject({
			status: 'ready',
			checks: expect.arrayContaining([
				expect.objectContaining({ name: 'scanner', status: 'degraded', essential: false }),
				expect.objectContaining({ name: 'mediaProbe', status: 'degraded', essential: false }),
				expect.objectContaining({ name: 'maintenance', status: 'degraded', essential: false }),
				expect.objectContaining({ name: 'timeline', status: 'degraded', essential: false }),
				expect.objectContaining({ name: 'playoutSync', status: 'degraded', essential: false }),
			]),
		});
	});
});
