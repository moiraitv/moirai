import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	testMatch: 'user-documentation.spec.ts',
	globalSetup: './tests/e2e/documentation/setup.ts',
	outputDir: 'test-results/documentation',
	workers: 1,
	timeout: 90_000,
	use: {
		actionTimeout: 15_000,
		navigationTimeout: 30_000,
		viewport: { width: 1440, height: 900 },
		locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce',
		trace: 'retain-on-failure',
		launchOptions: {
			args: ['--disable-gpu'],
			...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } : {}),
		},
	},
});
