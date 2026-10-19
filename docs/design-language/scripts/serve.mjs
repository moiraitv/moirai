import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Serve only the local design reference, never application data or repository parents. */
export const referenceRoot = fileURLToPath(new URL('../', import.meta.url));
/** Explicit media types needed by the offline reference. */
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

/** Start the reference server; capture and verification default to isolated loopback ports. */
export async function serve(port = 0, host = '127.0.0.1') {
	const server = http.createServer(async (request, response) => {
		try {
			const url = new URL(request.url, 'http://127.0.0.1');
			const requested = decodeURIComponent(url.pathname);
			const target = path.resolve(referenceRoot, `.${requested === '/' ? '/index.html' : requested}`);
			if (!target.startsWith(referenceRoot) || !['GET', 'HEAD'].includes(request.method)) {
				response.writeHead(403).end();
				return;
			}
			const content = await readFile(target);
			response.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
			response.end(request.method === 'HEAD' ? undefined : content);
		}
		catch {
			response.writeHead(404).end('Reference asset not found');
		}
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});
	return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { url } = await serve(Number(process.env.MOIRAI_DESIGN_PORT ?? 4179), '0.0.0.0');
	console.log(`Moirai design reference: ${url} (listening on 0.0.0.0)`);
}
