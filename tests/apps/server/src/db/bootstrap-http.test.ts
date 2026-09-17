import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startBootstrapServer, stopBootstrapServer } from '@server/db/bootstrap-http.js';
import type { BootstrapMigrationState } from '@server/db/bootstrap-http.js';

const servers: Array<Awaited<ReturnType<typeof startBootstrapServer>>> = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => stopBootstrapServer(server)));
});

/** Bind a bootstrap listener on an ephemeral port. */
async function listen(state: BootstrapMigrationState): Promise<string> {
	const server = await startBootstrapServer('127.0.0.1', 0, state);
	servers.push(server);
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

describe('bootstrap HTTP', () => {
	const state: BootstrapMigrationState = {
		status: 'migrating',
		progress: { applied: 2, total: 4, percent: 50, currentTag: '0002_example' },
	};

	it('serves an unauthenticated updating page and health probes', async () => {
		const origin = await listen(state);
		const html = await fetch(`${origin}/`);
		expect(html.status).toBe(200);
		const page = await html.text();
		expect(page).toContain('Updating the database');
		expect(page).not.toMatch(/catch\s*\{\s*location\.reload/);
		expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
		expect(html.headers.get('connection')).toBe('close');

		const live = await fetch(`${origin}/api/v1/health/live`);
		expect(live.status).toBe(200);
		expect(await live.json()).toEqual({ status: 'ok' });

		const ready = await fetch(`${origin}/api/v1/health/ready`);
		expect(ready.status).toBe(200);
		expect(await ready.json()).toMatchObject({
			status: 'ready',
			checks: [{ name: 'migration', status: 'degraded', essential: false }],
		});

		const startup = await fetch(`${origin}/api/v1/health/startup`);
		expect(startup.status).toBe(200);
		expect(await startup.json()).toMatchObject({
			status: 'migrating',
			applied: 2,
			total: 4,
			percent: 50,
			currentTag: '0002_example',
		});
	});

	it('rejects other API routes while migrations run', async () => {
		const origin = await listen(state);
		const response = await fetch(`${origin}/api/v1/channels`);
		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('5');
	});
});
