import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '..',
	testMatch: ['**/design-language/application.spec.ts', '**/ui-feedback.spec.ts'],
	outputDir: '../../../test-results/design-language-application',
	workers: 1,
	timeout: 240_000,
	expect: { timeout: 15_000 },
	use: {
		viewport: { width: 1440, height: 1000 },
		actionTimeout: 15000,
		locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark',
		contextOptions: { reducedMotion: 'reduce' },
		trace: 'retain-on-failure',
		launchOptions: { args: ['--disable-gpu'] },
	},
});
