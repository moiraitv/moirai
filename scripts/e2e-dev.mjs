import { rm } from 'node:fs/promises';
import path from 'node:path';

/** Isolated runtime root cleared before each browser-test server starts. */
const runtimeRoot = path.resolve('test-results/runtime');

/** Test API port forwarded by the Playwright server configuration. */
const apiPort = process.env.MOIRAI_PORT ?? '3008';
/** Test browser origin forwarded by the Playwright server configuration. */
const webPort = process.env.MOIRAI_WEB_PORT ?? '5178';

// Keep developer playback, authentication, and networking settings out of the test server.
for (const key of Object.keys(process.env)) {
	if (key.startsWith('MOIRAI_')) {
		delete process.env[key];
	}
}
Object.assign(process.env, {
	MOIRAI_HOST: '127.0.0.1',
	MOIRAI_PORT: apiPort,
	MOIRAI_WEB_PORT: webPort,
	MOIRAI_PUBLIC_URL: `http://127.0.0.1:${apiPort}`,
	MOIRAI_MANAGEMENT_URL: `http://127.0.0.1:${webPort}`,
	MOIRAI_API_TARGET: `http://127.0.0.1:${apiPort}`,
	MOIRAI_DATA_DIR: path.join(runtimeRoot, 'data'),
	MOIRAI_LOG_LEVEL: 'warn',
	MOIRAI_FFPROBE_PATH: path.resolve('tests/fixtures/fake-ffprobe.mjs'),
	MOIRAI_ETV_CHANNEL_PATH: process.execPath,
	MOIRAI_MEDIA_PROBE_CONCURRENCY: '8',
});

// Browser tests author persistent resources, so each server run needs an isolated empty catalog.
await Promise.all([
	rm(path.join(runtimeRoot, 'data'), { recursive: true, force: true }),
	rm(path.join(runtimeRoot, 'etv'), { recursive: true, force: true }),
]);
await import('./dev.mjs');
