import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test as base, expect } from '@playwright/test';
import { registerCaptureDirectory } from './capture';
import { waitForDocumentationServer } from './readiness';

/** Fixed instant shared with the isolated server preload. */
export const documentationNow = new Date('2026-01-15T10:30:00Z');

/** An independently booted real backend for each capture workflow. */
export const test = base.extend<{ documentationServer: { url: string; directory: string } }>({
	// Playwright requires destructuring even when a fixture has no dependencies.
	// eslint-disable-next-line no-empty-pattern
	documentationServer: [async ({}, use, testInfo) => {
		const root = path.resolve('test-results/documentation-runtime');
		await mkdir(root, { recursive: true });
		const directory = await mkdtemp(path.join(root, 'scene-'));
		const port = Number(process.env.MOIRAI_DOCS_TEST_PORT ?? 3198) + testInfo.parallelIndex;
		const url = `http://127.0.0.1:${port}`;
		let output = '';
		const child = spawn(process.execPath, [
			'--import', path.resolve('tests/e2e/documentation/clock.mjs'),
			path.resolve('tests/e2e/documentation/server.mjs'),
		], {
			env: {
				...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOIRAI_'))),
				TZ: 'UTC', MOIRAI_TIME_ZONE: 'UTC', MOIRAI_HOST: '127.0.0.1',
				MOIRAI_PORT: String(port), MOIRAI_PUBLIC_URL: url, MOIRAI_MANAGEMENT_URL: url,
				MOIRAI_DATA_DIR: path.join(directory, 'data'), MOIRAI_LOG_DIR: path.join(directory, 'logs'),
				MOIRAI_PLAYBACK_STREAM_DIR: 'streams', MOIRAI_PLAYBACK_PLAYOUT_DIR: 'playout',
				MOIRAI_FFPROBE_PATH: path.resolve('tests/fixtures/fake-ffprobe.mjs'),
				MOIRAI_ETV_CHANNEL_PATH: process.execPath, MOIRAI_MEDIA_PROBE_CONCURRENCY: '8',
				MOIRAI_LOG_LEVEL: 'warn',
			},
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		});
		child.stdout!.on('data', (chunk) => {
			output = `${output}${chunk}`.slice(-20_000);
		});
		child.stderr!.on('data', (chunk) => {
			output = `${output}${chunk}`.slice(-20_000);
		});
		const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
		try {
			await waitForDocumentationServer(child);
			await expect.poll(async () => {
				if (child.exitCode !== null) {
					throw new Error(`Documentation server exited: ${output}`);
				}
				try {
					return (await fetch(`${url}/api/v1/auth/session`, { signal: AbortSignal.timeout(1000) })).ok;
				}
				catch {
					return false;
				}
			}, { timeout: 30_000 }).toBe(true);
			await use({ url, directory });
		}
		finally {
			child.kill('SIGTERM');
			await Promise.race([exited, delay(3000)]);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
			}
			await exited;
			await testInfo.attach('server-log', { body: output, contentType: 'text/plain' });
			await rm(directory, { recursive: true, force: true });
		}
	}, { timeout: 40_000 }],
	baseURL: async ({ documentationServer }, use) => {
		await use(documentationServer.url);
	},
	page: async ({ page }, use, testInfo) => {
		registerCaptureDirectory(page, testInfo.repeatEachIndex);
		await page.clock.setFixedTime(documentationNow);
		await use(page);
	},
});
