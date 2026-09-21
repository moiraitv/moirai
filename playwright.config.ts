import { defineConfig } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROME_PATH;
const webPort = Number(process.env.MOIRAI_E2E_WEB_PORT ?? 5178);
const apiPort = Number(process.env.MOIRAI_E2E_API_PORT ?? 3008);

export default defineConfig({
	testDir: 'tests/e2e',
	workers: 1,
	timeout: 90_000,
	// Local indexing and saves can take longer than five seconds under CPU contention.
	expect: { timeout: 30_000 },
	testIgnore: ['user-documentation.spec.ts', '**/performance/**'],
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
		env: { MOIRAI_PORT: String(apiPort), MOIRAI_WEB_PORT: String(webPort) },
	},
});
