import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			'@server': fileURLToPath(new URL('./apps/server/src', import.meta.url)),
			'@web': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
			'@shared-source': fileURLToPath(new URL('./packages/shared/src', import.meta.url)),
			'@ersatztv-source': fileURLToPath(
				new URL('./packages/ersatztv-contract/src', import.meta.url),
			),
			'@scripts': fileURLToPath(new URL('./scripts', import.meta.url)),
		},
	},
	test: {
		include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
		coverage: { reporter: ['text', 'html'] },
	},
});
