import { defineConfig } from '@playwright/test';
import path from 'node:path';

const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
const webPort = Number(process.env.MOIRAI_E2E_WEB_PORT ?? 5178);
const apiPort = Number(process.env.MOIRAI_E2E_API_PORT ?? 3008);

export default defineConfig({
	testDir: 'tests/e2e',
	testIgnore: 'user-documentation.spec.ts',
	outputDir: 'test-results/playwright',
	use: {
		baseURL: `http://127.0.0.1:${webPort}`,
		trace: 'retain-on-failure',
		...(executablePath ? { launchOptions: { executablePath } } : {}),
	},
	webServer: {
		command: 'node scripts/e2e-dev.mjs',
		url: `http://127.0.0.1:${webPort}`,
		reuseExistingServer: false,
		env: {
			MOIRAI_DATA_DIR: './test-results/runtime/data',
			MOIRAI_LOG_LEVEL: 'warn',
			MOIRAI_PORT: String(apiPort),
			MOIRAI_WEB_PORT: String(webPort),
			MOIRAI_API_TARGET: `http://127.0.0.1:${apiPort}`,
			MOIRAI_FFPROBE_PATH: path.resolve('tests/fixtures/fake-ffprobe.mjs'),
			MOIRAI_ETV_CHANNEL_PATH: process.execPath,
			MOIRAI_MEDIA_PROBE_CONCURRENCY: '8',
		},
	},
});
