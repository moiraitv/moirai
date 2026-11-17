import { Agent, fetch as undiciFetch } from 'undici';
import { MEDIA_JSON_MAX_BYTES, MEDIA_REQUEST_TIMEOUT_MS } from './limits.js';
import { readMediaBytes } from './response-body.js';

/** Caller-supplied request used by media-server clients and tests. */
export interface MediaFetchInit {
	method?: 'GET' | 'POST' | undefined;
	headers?: Record<string, string> | undefined;
	body?: string | undefined;
	signal?: AbortSignal | undefined;
	/** Long-lived playback reads use caller cancellation instead of the metadata deadline. */
	streaming?: boolean | undefined;
}

/** Minimal response consumed by provider clients. */
export interface MediaFetchResponse {
	ok: boolean;
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	body: ReadableStream<Uint8Array> | null;
}

/** Function that performs one media-server HTTP request. */
export type MediaFetch = (url: string, init?: MediaFetchInit) => Promise<MediaFetchResponse>;

/** Failure whose message is safe to show and does not include the credential. */
export class MediaServerRequestError extends Error {
	constructor(message: string, public readonly status: number | null = null) {
		super(message);
		this.name = 'MediaServerRequestError';
	}
}

/** How many same-origin redirects one provider request may follow. */
const MAX_SAME_ORIGIN_REDIRECTS = 5;

/** Shared certificate-exception pool, matching the lifetime of undici's default pool. */
let insecureDispatcher: Agent | undefined;

/**
 * Build a fetch implementation that can accept one server's certificate choice.
 * Redirects are manual because undici would forward `X-Plex-Token` and `X-Emby-Token`
 * to another origin. Only a same-origin GET redirect is followed.
 */
export function createMediaFetch(allowInsecureTls: boolean): MediaFetch {
	const dispatcher = allowInsecureTls
		? (insecureDispatcher ??= new Agent({ connect: { rejectUnauthorized: false } }))
		: undefined;
	return async (url, init) => {
		try {
			return await request(url, init);
		}
		catch (error) {
			if (error instanceof MediaServerRequestError) {
				throw error;
			}

			throw new MediaServerRequestError('Media server request failed or timed out');
		}
	};

	/** Keep all request construction failures inside the credential-safe boundary. */
	async function request(url: string, init?: MediaFetchInit): Promise<MediaFetchResponse> {
		const signal = init?.streaming ? init.signal : mediaRequestSignal(init?.signal);
		const origin = new URL(url).origin;
		let current = url;
		let method = init?.method ?? 'GET';
		for (let redirect = 0;; redirect += 1) {
			const response = await undiciFetch(current, {
				method,
				redirect: 'manual',
				...(init?.headers ? { headers: init.headers } : {}),
				...(init?.body !== undefined && method !== 'GET' ? { body: init.body } : {}),
				...(signal ? { signal } : {}),
				...(dispatcher ? { dispatcher } : {}),
			});
			const location = response.headers.get('location');
			const redirecting = response.status >= 300 && response.status < 400 && location && method === 'GET';
			if (!redirecting) {
				return response as unknown as MediaFetchResponse;
			}

			if (redirect >= MAX_SAME_ORIGIN_REDIRECTS) {
				await response.body?.cancel();
				throw new MediaServerRequestError('Media server redirected too many times');
			}

			let next: URL;
			try {
				next = new URL(location, current);
			}
			catch {
				await response.body?.cancel();
				throw new MediaServerRequestError('Media server returned a redirect Moirai could not read');
			}

			if (next.origin !== origin) {
				await response.body?.cancel();
				throw new MediaServerRequestError('Media server redirected to a different address');
			}

			await response.body?.cancel();
			current = next.toString();
			method = 'GET';
		}
	}
}

/** Require an http(s) origin without embedded userinfo, and drop a trailing slash. */
export function normalizeBaseUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	}
	catch {
		throw new MediaServerRequestError('Enter a valid server address');
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new MediaServerRequestError('Server address must start with http:// or https://');
	}

	if (parsed.username || parsed.password) {
		throw new MediaServerRequestError('Put the credential in the token field, not the server address');
	}

	if (parsed.href.includes('?') || parsed.href.includes('#')) {
		throw new MediaServerRequestError('Server address cannot contain a query string or fragment');
	}

	return parsed.toString().replace(/\/$/, '');
}

/** Read a JSON body or raise a credential-safe failure. */
export async function readJson<T>(
	response: MediaFetchResponse,
	label: string,
	onBytes?: (bytes: number) => void,
): Promise<T> {
	if (response.status === 401 || response.status === 403) {
		await response.body?.cancel();
		throw new MediaServerRequestError(`${label} rejected the credential`, response.status);
	}

	if (!response.ok) {
		await response.body?.cancel();
		throw new MediaServerRequestError(`${label} returned HTTP ${response.status}`, response.status);
	}

	try {
		const bytes = await readMediaBytes(response, MEDIA_JSON_MAX_BYTES, onBytes);
		return JSON.parse(bytes.toString('utf8')) as T;
	}
	catch (error) {
		if (error instanceof MediaServerRequestError) {
			throw error;
		}

		throw new MediaServerRequestError(`${label} returned a response Moirai could not read`);
	}
}

/** Combine the provider deadline with optional caller cancellation. */
export function mediaRequestSignal(signal?: AbortSignal): AbortSignal {
	const deadline = AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** Join a provider path under its validated base path without accepting another origin. */
export function mediaServerUrl(baseUrl: string, pathname: string): string {
	const base = normalizeBaseUrl(baseUrl);
	if (!pathname.startsWith('/') || pathname.startsWith('//')) {
		throw new MediaServerRequestError('Media server returned an invalid resource path');
	}

	const origin = new URL(base).origin;
	const result = new URL(`${new URL(base).pathname.replace(/\/$/, '')}${pathname}`, origin);
	if (result.origin !== origin || result.username || result.password) {
		throw new MediaServerRequestError('Media server returned an invalid resource path');
	}

	return result.href;
}
