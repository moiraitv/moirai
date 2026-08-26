import { describe, expect, it, vi } from 'vitest';
import { HealthService } from '@server/operations/health-service.js';
import type { MaintenanceService } from '@server/operations/maintenance.js';
import type { PlaybackEngine } from '@server/playback/playback-engine.js';
import type { PlayoutSynchronizer } from '@server/playback/playout-synchronizer.js';
import type { Repository } from '@server/repository/index.js';
import type { ScannerManager } from '@server/scanner/manager.js';
import type { TimelineMaterializer } from '@server/scheduling/timeline-materializer.js';

/** Build health dependencies with ready process services and no persisted failures. */
function fixture(overrides: {
	libraries?: unknown[];
	playback?: { status: 'ready' | 'degraded'; detail?: string };
} = {}): HealthService {
	const repository = {
		checkDatabase: vi.fn(),
		listTimelineMaterializationStatuses: vi.fn().mockResolvedValue([]),
		listLibraries: vi.fn().mockResolvedValue(overrides.libraries ?? []),
	} as unknown as Repository;
	const scanner = {
		health: () => ({ status: 'ready' as const }),
	} as unknown as ScannerManager;
	const timeline = {
		health: () => ({ status: 'ready' as const }),
	} as unknown as TimelineMaterializer;
	const maintenance = {
		health: () => ({ status: 'ready' as const }),
	} as unknown as MaintenanceService;
	const playback = {
		health: () => overrides.playback ?? { status: 'ready' as const },
	} as unknown as PlaybackEngine;
	const playout = {
		health: () => ({ status: 'ready' as const }),
	} as unknown as PlayoutSynchronizer;
	return new HealthService(repository, scanner, timeline, maintenance, playback, playout);
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
});
