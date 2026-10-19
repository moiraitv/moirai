import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Drain admitted configuration mutations before capturing assets. Live reads and playback delivery
 * continue during capture; maintenance rejects all new work before services release their resources.
 */
export class BackupFence {
	private capturing = false;
	private maintenance = false;
	private readonly active = new Set<FastifyRequest>();
	private drained: (() => void) | null = null;

	/** Register lifecycle accounting before route handlers can mutate managed resources. */
	register(app: FastifyInstance): void {
		app.addHook('onRequest', (request, _reply, done) => {
			const route = request.routeOptions.url ?? request.url;
			if (this.maintenance && !route.startsWith('/api/v1/health/')) {
				done(app.httpErrors.serviceUnavailable('Configuration restore is restarting Moirai'));
				return;
			}
			if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || route.startsWith('/api/v1/backups')) {
				done();
				return;
			}
			if (this.capturing) {
				done(app.httpErrors.serviceUnavailable('A backup is capturing configuration; try again shortly'));
				return;
			}
			this.active.add(request);
			done();
		});
		const release = async (request: FastifyRequest): Promise<void> => {
			this.active.delete(request);
			if (!this.active.size) {
				this.drained?.();
			}
		};
		app.addHook('onResponse', release);
		app.addHook('onRequestAbort', release);
	}

	/** Wait for admitted writes, then hold managed configuration stable until snapshot capture ends. */
	async capture(): Promise<() => void> {
		this.capturing = true;
		if (this.active.size) {
			await new Promise<void>(resolve => {
				this.drained = resolve; 
			});
		}
		this.drained = null;
		return () => {
			this.capturing = false; 
		};
	}

	/** Prevent new requests from starting consumers while the application is being replaced. */
	enterMaintenance(): void {
		this.maintenance = true;
	}

	/** Resume the unchanged application when preparation failed before replacement began. */
	leaveMaintenance(): void {
		this.maintenance = false;
	}
}
