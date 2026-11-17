import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openProviderArtwork } from '@server/media-servers/artwork-file.js';
import * as artwork from '@server/media-servers/artwork-file.js';
import { ProviderArtworkDownloads } from '@server/media-servers/artwork-downloads.js';
import { MEDIA_ARTWORK_QUEUE_LIMIT, MEDIA_REQUEST_TIMEOUT_MS } from '@server/media-servers/limits.js';
import { SourceFileError } from '@server/media/source-file.js';

afterEach(() => vi.restoreAllMocks());

describe('bounded provider artwork', () => {
	it('streams into a readable private file and removes oversized partial downloads', async () => {
		const before = new Set(await readdir(tmpdir()));
		const upstream = createServer((request, response) => {
			response.writeHead(200, { 'content-type': 'image/jpeg' });
			response.write(Buffer.alloc(request.url === '/large' ? 2_048 : 512, 65));
			response.end();
		});
		await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
		const servers = { getMediaServerConnection: async () => ({ id: 'audit', provider: 'plex' as const, name: 'Audit', serverKey: 'audit', serverName: 'Audit', baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, accessToken: 'audit-token', clientIdentifier: 'audit-client', allowInsecureTls: false, playbackReportingEnabled: false, pathReplacements: [] }) };
		try {
			const file = await openProviderArtwork(servers, 'audit', 'provider-image:/small', 1_024);
			expect(file.file.stat.mode & 0o777).toBe(0o600);
			expect((await file.file.handle.readFile()).length).toBe(512);
			await file.cleanup();
			await expect(readFile(file.file.path)).rejects.toMatchObject({ code: 'ENOENT' });
			await expect(openProviderArtwork(servers, 'audit', 'provider-image:/large', 1_024)).rejects.toMatchObject({ reason: 'too-large' });
			expect((await readdir(tmpdir())).filter((file) => file.startsWith('moirai-artwork-') && !before.has(file))).toEqual([]);
		}
		finally {
			await new Promise<void>((resolve) => upstream.close(() => resolve()));
		}
	});

	it('keeps permits until cleanup, rejects excess admission, and releases cancelled waiters', async () => {
		const close = vi.fn(async () => undefined);
		const opener = vi.spyOn(artwork, 'openProviderArtwork').mockResolvedValue({ file: {} as never, cleanup: close });
		const downloads = new ProviderArtworkDownloads(1);
		const servers = {} as never;
		const first = await downloads.open(servers, 'audit', '/image', 1_024);
		const abort = new AbortController();
		const waiting = Array.from({ length: MEDIA_ARTWORK_QUEUE_LIMIT }, () => downloads.open(servers, 'audit', '/image', 1_024, abort.signal));
		const settled = Promise.allSettled(waiting);
		await expect(downloads.open(servers, 'audit', '/image', 1_024)).rejects.toMatchObject({ statusCode: 503 });
		expect(opener).toHaveBeenCalledTimes(1);
		abort.abort();
		expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
		await first.cleanup();
		await first.cleanup();
		expect(close).toHaveBeenCalledTimes(1);
		const next = await downloads.open(servers, 'audit', '/image', 1_024);
		await next.cleanup();
		expect(opener).toHaveBeenCalledTimes(2);
	});

	it('releases admission after a failed download', async () => {
		const opener = vi.spyOn(artwork, 'openProviderArtwork').mockRejectedValueOnce(new SourceFileError('unavailable', 'Audit failure'))
			.mockResolvedValue({ file: {} as never, cleanup: async () => undefined });
		const downloads = new ProviderArtworkDownloads(1);
		await expect(downloads.open({} as never, 'audit', '/image', 1)).rejects.toThrow(/Audit failure/);
		const next = await downloads.open({} as never, 'audit', '/image', 1);
		await next.cleanup();
		expect(opener).toHaveBeenCalledTimes(2);
	});
});


it('expires queued artwork within the original deadline and releases its waiting slot', async () => {
	const opener = vi.spyOn(artwork, 'openProviderArtwork').mockResolvedValue({ file: {} as never, cleanup: async () => undefined });
	const downloads = new ProviderArtworkDownloads(1);
	const first = await downloads.open({} as never, 'audit', '/image', 1);
	const deadline = new AbortController();
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
	const waiting = downloads.open({} as never, 'audit', '/image', 1);
	const expired = expect(waiting).rejects.toThrow(/cancelled or timed out/);
	deadline.abort();
	await expired;
	expect(timeout).toHaveBeenCalledWith(MEDIA_REQUEST_TIMEOUT_MS);
	expect(opener).toHaveBeenCalledTimes(1);
	await first.cleanup();
	timeout.mockRestore();
	const next = await downloads.open({} as never, 'audit', '/image', 1);
	await next.cleanup();
	expect(opener).toHaveBeenCalledTimes(2);
});
