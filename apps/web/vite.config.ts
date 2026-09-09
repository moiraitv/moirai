import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig, type Plugin } from 'vite';

/** Development-only Vite server port; production traffic uses the Fastify server port. */
const webPort = Number(process.env.MOIRAI_WEB_PORT ?? 5173);
const apiPort = Number(process.env.MOIRAI_PORT ?? 3000);
const apiTarget = process.env.MOIRAI_API_TARGET ?? `http://127.0.0.1:${apiPort}`;

/** Return whether a Vite management hostname is confined to the local loopback interfaces. */
function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
	return normalized === 'localhost'
		|| normalized === '::1'
		|| /^127(?:\.[0-9]{1,3}){3}$/u.test(normalized);
}

/** Choose a reachable Vite bind address without trusting arbitrary Host headers. */
export function developmentWebHost(
	managementUrl: string | undefined,
	explicitHost: string | undefined,
): string {
	if (explicitHost?.trim()) {
		return explicitHost.trim();
	}
	if (!managementUrl?.trim()) {
		return '127.0.0.1';
	}

	const hostname = new URL(managementUrl).hostname.replace(/^\[|\]$/gu, '');
	return isLoopbackHostname(hostname) ? hostname : '0.0.0.0';
}

/** Restrict Vite requests to the single configured management hostname. */
export function developmentAllowedHosts(managementUrl: string | undefined): string[] {
	return managementUrl?.trim()
		? [new URL(managementUrl).hostname.replace(/^\[|\]$/gu, '')]
		: [];
}

const managementUrl = process.env.MOIRAI_MANAGEMENT_URL;

/** Serve generated contextual help, screenshots, and icons during Vite development. */
function userDocumentationPlugin(): Plugin {
	const docsPublicRoot = fileURLToPath(new URL('../docs/src/public/', import.meta.url));
	return {
		name: 'moirai-user-documentation',
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
				let assetPath: string | undefined;
				let contentType: string | undefined;
				if (pathname === '/help/contextual-help.json') {
					assetPath = path.join(docsPublicRoot, 'contextual-help.json');
					contentType = 'application/json; charset=utf-8';
				}
				else if (/^\/help\/screenshots\/[a-z0-9-]+\.png$/u.test(pathname)) {
					assetPath = path.join(docsPublicRoot, pathname.slice('/help/'.length));
					contentType = 'image/png';
				}
				else if (/^\/help\/icons\/[a-z0-9-]+\.svg$/u.test(pathname)) {
					assetPath = path.join(docsPublicRoot, pathname.slice('/help/'.length));
					contentType = 'image/svg+xml';
				}
				if (!assetPath || !contentType) {
					next();
					return;
				}

				void readFile(assetPath).then((contents) => {
					response.statusCode = 200;
					response.setHeader('Content-Type', contentType);
					response.end(contents);
				}).catch(() => next());
			});
		},
	};
}

export default defineConfig({
	plugins: [vue(), userDocumentationPlugin()],
	resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
	server: {
		host: developmentWebHost(managementUrl, process.env.MOIRAI_WEB_HOST),
		port: webPort,
		strictPort: true,
		allowedHosts: developmentAllowedHosts(managementUrl),
		proxy: { '/api': { target: apiTarget, ws: true }, '/help': { target: apiTarget } },
	},
});
