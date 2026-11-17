import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it('keeps the process alive after excessive content encodings and an early provider disconnect', async () => {
	const server = createServer((_request, response) => {
		response.writeHead(200, {
			'Content-Encoding': Array.from({ length: 6 }, () => 'gzip').join(','),
			'Content-Length': '1000',
		});
		response.flushHeaders();
		setTimeout(() => response.destroy(), 25);
	});
	try {
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/malformed-response`;
		const module = pathToFileURL(path.resolve('apps/server/src/media-servers/http.ts')).href;
		const script = `
			import { createMediaFetch } from ${JSON.stringify(module)};
			try {
				const response = await createMediaFetch(false)(${JSON.stringify(url)});
				await response.text();
			}
			catch {
				console.log('handled-provider-error');
			}
			setTimeout(() => console.log('process-survived'), 100);
		`;
		const result = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
			timeout: 10_000, maxBuffer: 1_048_576,
		});
		expect(result.stdout).toContain('handled-provider-error');
		expect(result.stdout).toContain('process-survived');
		expect(result.stderr).not.toContain("Unhandled 'error' event");
	}
	finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});
