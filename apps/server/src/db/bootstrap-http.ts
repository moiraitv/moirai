import http from 'node:http';
import type { z } from 'zod';
import { startupStatusSchema } from '@moirai/shared/api-contracts';
import type { MigrationProgress } from './migrations.js';

/** Public startup payload served while the bootstrap listener is bound. */
export type StartupStatus = z.infer<typeof startupStatusSchema>;

/** Mutable migration progress shared between the worker and HTTP handlers. */
export interface BootstrapMigrationState {
	status: StartupStatus['status'];
	progress: MigrationProgress;
	error?: string;
}

const FRAME_ANCESTORS_POLICY = "frame-ancestors 'none'";

/** Build the JSON body for GET /api/v1/health/startup. */
export function startupStatusFromState(state: BootstrapMigrationState): StartupStatus {
	return {
		status: state.status,
		applied: state.progress.applied,
		total: state.progress.total,
		percent: state.progress.percent,
		...(state.progress.currentTag ? { currentTag: state.progress.currentTag } : {}),
		...(state.error ? { error: state.error } : {}),
	};
}

/** Self-contained HTML that polls startup status until the application reloads. */
export function renderMigrationPage(state: BootstrapMigrationState): string {
	const status = startupStatusFromState(state);
	const label = status.status === 'failed'
		? 'Database update failed'
		: 'Updating the database';
	const detail = status.status === 'failed'
		? (status.error ?? 'The database update did not finish.')
		: status.currentTag
			? `Applying ${status.currentTag} (${status.applied} of ${status.total})`
			: status.total === 0
				? 'Preparing the database'
				: `${status.applied} of ${status.total} updates applied`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b0e14">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'">
<title>Moirai is updating</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: #0b0e14; color: #ecf4f7;
	font: 16px/1.5 system-ui, sans-serif; display: grid; place-items: center; padding: 24px; }
main { max-width: 36rem; }
.eyebrow { color: #20d9b0; font-size: 12px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
h1 { font-size: 1.75rem; margin: .35em 0 .5em; }
p { color: #aab8c4; }
.bar { height: 8px; background: #1a2430; border-radius: 99px; overflow: hidden; margin: 1.25rem 0 .75rem; }
.fill { height: 100%; width: ${status.percent}%; background: #20d9b0; transition: width .4s ease; }
</style>
</head>
<body>
<main>
<p class="eyebrow">Moirai</p>
<h1>${escapeHtml(label)}</h1>
<p>This can take several minutes after an upgrade. The application reloads when it is ready.</p>
<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${status.percent}">
<div class="fill" id="fill"></div>
</div>
<p id="detail">${escapeHtml(detail)}</p>
</main>
<script>
async function tick() {
	try {
		const response = await fetch('/api/v1/health/startup');
		if (response.status === 404) {
			location.reload();
			return;
		}
		const body = await response.json();
		if (body.status === 'ready') {
			location.reload();
			return;
		}
		const fill = document.getElementById('fill');
		const detail = document.getElementById('detail');
		const bar = document.querySelector('.bar');
		if (fill) fill.style.width = (body.percent || 0) + '%';
		if (bar) bar.setAttribute('aria-valuenow', String(body.percent || 0));
		if (detail) {
			if (body.status === 'failed') {
				detail.textContent = body.error || 'The database update did not finish.';
				document.querySelector('h1').textContent = 'Database update failed';
			}
			else if (body.currentTag) {
				detail.textContent = 'Applying ' + body.currentTag + ' (' + body.applied + ' of ' + body.total + ')';
			}
			else {
				detail.textContent = body.applied + ' of ' + body.total + ' updates applied';
			}
		}
	}
	catch {
		setTimeout(tick, 1000);
		return;
	}
	setTimeout(tick, 1000);
}
tick();
</script>
</body>
</html>
`;
}

/** Escape text interpolated into the bootstrap HTML document. */
function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** Listen for unauthenticated migration-status requests before SQLite is ready. */
export function startBootstrapServer(
	host: string,
	port: number,
	state: BootstrapMigrationState,
): Promise<http.Server> {
	const server = http.createServer((request, response) => {
		const url = request.url ?? '/';
		const path = url.split('?')[0] ?? '/';
		response.setHeader('X-Frame-Options', 'DENY');
		response.setHeader('Content-Security-Policy', FRAME_ANCESTORS_POLICY);
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('Connection', 'close');
		if (path === '/api/v1/health/live') {
			sendJson(response, 200, { status: 'ok' });
			return;
		}
		if (path === '/api/v1/health/ready') {
			sendJson(response, 200, {
				status: 'ready',
				checks: [{
					name: 'migration',
					status: 'degraded',
					essential: false,
					detail: state.status === 'failed'
						? (state.error ?? 'Database migrations failed')
						: 'Database migrations are running',
				}],
			});
			return;
		}
		if (path === '/api/v1/health/startup') {
			sendJson(response, 200, startupStatusFromState(state));
			return;
		}
		if (path.startsWith('/api/')) {
			response.setHeader('Retry-After', '5');
			sendJson(response, 503, {
				code: 'unavailable',
				message: 'Moirai is updating the database',
				requestId: 'bootstrap',
			});
			return;
		}

		response.statusCode = 200;
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(renderMigrationPage(state));
	});
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => resolve(server));
	});
}

/** Close the bootstrap listener so the full application can bind the same port. */
export function stopBootstrapServer(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.closeAllConnections();
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

/** Write a JSON response for a bootstrap health or error payload. */
function sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
	response.statusCode = statusCode;
	response.setHeader('Content-Type', 'application/json; charset=utf-8');
	response.end(JSON.stringify(body));
}
