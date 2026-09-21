import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e/performance',
	workers: 1,
	timeout: 180_000,
	outputDir: 'test-results/performance',
	use: { baseURL: 'http://127.0.0.1:4179', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
	webServer: {
		command: 'npx vite preview --host 127.0.0.1 --port 4179 --strictPort',
		cwd: 'apps/web',
		url: 'http://127.0.0.1:4179',
	},
});
