import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

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

export default defineConfig({
	plugins: [vue()],
	resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
	server: {
		host: developmentWebHost(managementUrl, process.env.MOIRAI_WEB_HOST),
		port: webPort,
		strictPort: true,
		allowedHosts: developmentAllowedHosts(managementUrl),
		proxy: { '/api': { target: apiTarget, ws: true } },
	},
});
