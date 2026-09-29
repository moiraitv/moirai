import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDiagnosticDirectory, diagnosticFetch } from '@scripts/ai-comparison-diagnostics.js';

it('creates private run directories beside the comparison config', async () => {
	const parent = await mkdtemp(join(tmpdir(), 'moirai-comparison-test-'));
	try {
		const directory = await createDiagnosticDirectory(join(parent, 'config.json'));
		expect(directory).toMatch(new RegExp(`^${parent}/ai-diagnostics-`));
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
	}
	finally {
		await rm(parent, { recursive: true, force: true });
	}
});

it('keeps malformed replies and transport errors without storing keys', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'moirai-capture-test-'));
	try {
		let request = 0;
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			request += 1;
			if (request === 1) {
				return new Response('malformed private-key', { status: 200 });
			}
			throw new TypeError('private-key transport failure', { cause: Object.assign(new Error('closed'), { code: 'ECONNRESET' }) });
		});
		const capture = diagnosticFetch(directory, ['private-key'], () => 'reviewing batch 1/2', fetchImpl);
		const options = { method: 'POST', headers: { authorization: 'Bearer private-key' }, body: '{"prompt":"private-key"}' };
		expect((await capture('https://example.test/chat/completions', options)).status).toBe(200);
		await expect(capture('https://example.test/chat/completions', options)).rejects.toThrow();

		const firstRequest = await readFile(join(directory, 'request-001.json'), 'utf8');
		const firstResponse = await readFile(join(directory, 'response-001.json'), 'utf8');
		const secondError = await readFile(join(directory, 'error-002.json'), 'utf8');
		expect(firstRequest).toContain('[REDACTED]');
		expect(firstRequest).not.toContain('authorization');
		expect(firstResponse).toContain('malformed [REDACTED]');
		expect(secondError).toContain('TypeError');
		expect(secondError).toContain('ECONNRESET');
		expect([firstRequest, firstResponse, secondError].join('')).not.toContain('private-key');
		expect((await stat(join(directory, 'response-001.json'))).mode & 0o777).toBe(0o600);
	}
	finally {
		await rm(directory, { recursive: true, force: true });
	}
});
