import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.',
	testMatch: 'source-audit.spec.ts',
	outputDir: '../../../test-results/design-language-source',
	workers: 1,
	timeout: 180_000,
	use: {
		viewport: { width: 1440, height: 1000 },
		actionTimeout: 15000,
		locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark',
		contextOptions: { reducedMotion: 'reduce' },
		launchOptions: { args: ['--disable-gpu'] },
	},
});
