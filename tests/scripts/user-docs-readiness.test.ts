import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { waitForDocumentationServer } from '../e2e/documentation/readiness';

beforeAll(() => {
	execFileSync('npm', ['run', 'build', '-w', '@moirai/server'], { stdio: 'pipe' });
}, 30_000);

it.each([true, false])('requires its own real server to bind (occupied port: %s)', async (occupied) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'moirai-docs-readiness-'));
	let foreignRequests = 0;
	const existing = createServer((_request, response) => {
		foreignRequests += 1;
		response.writeHead(200);
		response.end('existing instance');
	});
	existing.listen(0, '127.0.0.1');
	await once(existing, 'listening');
	const address = existing.address();
	if (!address || typeof address === 'string') {
		throw new Error('Expected a TCP address');
	}
	const port = address.port;
	if (!occupied) {
		await new Promise<void>((resolve) => existing.close(() => resolve()));
	}
	const child = spawn(process.execPath, [
		'--import', path.resolve('tests/e2e/documentation/clock.mjs'),
		path.resolve('tests/e2e/documentation/server.mjs'),
	], {
		env: {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOIRAI_'))),
			MOIRAI_HOST: '127.0.0.1', MOIRAI_PORT: String(port),
			MOIRAI_PUBLIC_URL: `http://127.0.0.1:${port}`,
			MOIRAI_DATA_DIR: path.join(directory, 'data'), MOIRAI_LOG_DIR: path.join(directory, 'logs'),
			MOIRAI_LOG_LEVEL: 'warn', MOIRAI_ETV_CHANNEL_PATH: process.execPath,
			MOIRAI_FFPROBE_PATH: path.resolve('tests/fixtures/fake-ffprobe.mjs'),
		},
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
	});
	const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
	try {
		const ready = waitForDocumentationServer(child).then(async () => {
			return (await fetch(`http://127.0.0.1:${port}/api/v1/auth/session`)).json();
		});
		if (occupied) {
			await expect(ready).rejects.toThrow('exited before readiness');
			expect(foreignRequests).toBe(0);
		}
		else {
			await expect(ready).resolves.toMatchObject({ status: 'uninitialized' });
		}
	}
	finally {
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
		await closed;
		clearTimeout(timer);
		await new Promise<void>((resolve) => existing.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
}, 40_000);
