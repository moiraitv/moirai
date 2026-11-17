import { createHmac, timingSafeEqual } from 'node:crypto';

/** How long a signed loopback URL remains valid after the segment that uses it finishes. */
export const MEDIA_STREAM_GRACE_MILLISECONDS = 6 * 60 * 60 * 1_000;

/** Sign one media-server part for a loopback request. The provider token is not part of the signature. */
export function signMediaStream(
	secret: string,
	expiresAt: number,
	mediaServerId: string,
	partId: string,
): string {
	return createHmac('sha256', secret)
		.update(`${expiresAt}\n${mediaServerId}\n${partId}`)
		.digest('base64url');
}

/** Accept a signature only when it matches and has not expired. */
export function verifyMediaStream(
	secret: string,
	expiresAt: number,
	mediaServerId: string,
	partId: string,
	signature: string,
	now = Date.now(),
): boolean {
	if (!Number.isSafeInteger(expiresAt) || now > expiresAt) {
		return false;
	}

	const expected = signMediaStream(secret, expiresAt, mediaServerId, partId);
	const actualBuffer = Buffer.from(signature);
	const expectedBuffer = Buffer.from(expected);
	return actualBuffer.length === expectedBuffer.length
		&& timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Build the loopback URL the channel worker requests. It carries no provider credential. */
export function mediaStreamUrl(
	origin: string,
	mediaServerId: string,
	partId: string,
	expiresAt: number,
	signature: string,
): string {
	const query = new URLSearchParams({
		server: mediaServerId,
		part: partId,
		exp: String(expiresAt),
		sig: signature,
	});
	return `${origin.replace(/\/$/, '')}/api/v1/internal/media?${query}`;
}
