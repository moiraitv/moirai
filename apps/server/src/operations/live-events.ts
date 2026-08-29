import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
	LIVE_EVENT_PROTOCOL_VERSION,
	LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE,
	liveEventSchema,
	type LiveEvent,
	type LiveEventInput,
} from '@moirai/shared';
import type { AuthenticationSessionRecord } from '../auth/contracts.js';
import { currentTimestamp } from '../time.js';

/** Bound live events resource use for clients. */
const MAX_CLIENTS = 100;
/** Bound live events resource use for buffered bytes. */
const MAX_BUFFERED_BYTES = 256 * 1024;
/** WebSocket ready-state value indicating a writable connection. */
const WEB_SOCKET_OPEN = 1;
/** Largest safe delay accepted by Node's timer implementation. */
const MAX_TIMER_DELAY_MS = 2_147_000_000;

/** Authenticated socket plus the revocable session lifetime governing its access. */
interface LiveEventClient {
	socket: WebSocket;
	tokenHash: string;
	expiresAtMs: number;
	expirationTimer: NodeJS.Timeout | null;
}

/** Minimal event publisher used to decouple services from the WebSocket transport. */
export interface LiveEventPublisher {
	publish(event: LiveEventInput): void;
}

/** Shutdown options for connected live-event clients. */
export interface CloseLiveEventOptions {
	/** End sockets immediately so a process restart cannot remain blocked on close handshakes. */
	terminate?: boolean;
}

/** Resolve the latest durable expiry for one connected administrator session hash. */
export type LiveEventSessionExpiryResolver = (tokenHash: string) => Promise<number | null>;

/**
 * Publish validated, bounded change notifications to internal listeners and WebSocket clients. The
 * hub rejects excess or slow connections and deliberately leaves REST as the authoritative recovery
 * path after reconnecting.
 */
export class LiveEventHub implements LiveEventPublisher {
	private readonly clients = new Map<WebSocket, LiveEventClient>();
	private readonly listeners = new Set<(event: LiveEvent) => void>();

	constructor(
		private readonly resolveSessionExpiry: LiveEventSessionExpiryResolver | null = null,
	) {}

	/** Observe authoritative change events inside the server without opening a WebSocket. */
	subscribe(listener: (event: LiveEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Attach a WebSocket only for the lifetime of its resolved administrator session. */
	attach(socket: WebSocket, session: AuthenticationSessionRecord): void {
		if (this.clients.size >= MAX_CLIENTS) {
			socket.close(1013, 'Too many live event connections');
			return;
		}

		const client: LiveEventClient = {
			socket,
			tokenHash: session.tokenHash,
			expiresAtMs: Date.parse(session.expiresAt),
			expirationTimer: null,
		};
		this.clients.set(socket, client);
		socket.on('close', () => this.detach(socket));
		socket.on('error', () => this.detach(socket));
		// The stream is server-push-only for now. Reading prevents inbound backpressure.
		socket.on('message', () => undefined);
		this.scheduleExpiration(client);
		if (!this.clients.has(socket)) {
			return;
		}

		this.send(socket, {
			protocolVersion: LIVE_EVENT_PROTOCOL_VERSION,
			eventId: randomUUID(),
			occurredAt: currentTimestamp(),
			type: 'system.ready',
			data: { connectionId: randomUUID() },
		});
	}

	/** Validate and broadcast a live event to connected clients. */
	publish(input: LiveEventInput): void {
		const event = liveEventSchema.parse({
			protocolVersion: LIVE_EVENT_PROTOCOL_VERSION,
			eventId: randomUUID(),
			occurredAt: currentTimestamp(),
			...input,
		});
		for (const listener of this.listeners) {
			listener(event);
		}
		for (const client of this.clients.values()) {
			this.send(client.socket, event);
		}
	}

	/** Close clients whose hashed sessions were durably revoked by authentication workflows. */
	revokeSessions(tokenHashes: readonly string[]): void {
		const revoked = new Set(tokenHashes);
		for (const client of [...this.clients.values()]) {
			if (revoked.has(client.tokenHash)) {
				this.closeClient(client, 1008, 'Authentication session ended');
			}
		}
	}

	/** Reconnect clients whose valid replacement session will arrive through the response cookie. */
	replaceSessions(tokenHashes: readonly string[]): void {
		const replaced = new Set(tokenHashes);
		for (const client of [...this.clients.values()]) {
			if (replaced.has(client.tokenHash)) {
				this.closeClient(
					client,
					LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE,
					'Authentication session replaced',
				);
			}
		}
	}

	/** Close every live-event connection with the supplied WebSocket status. */
	close(options: CloseLiveEventOptions = {}): void {
		for (const client of [...this.clients.values()]) {
			this.detach(client.socket);
			if (options.terminate) {
				client.socket.terminate();
			}
			else {
				client.socket.close(1001, 'Server shutting down');
			}
		}
	}

	/** Release live-status sockets under severe pressure; clients reconnect through normal retry logic. */
	releaseConnections(): void {
		for (const client of [...this.clients.values()]) {
			this.closeClient(client, 1013, 'Server resource pressure; reconnect shortly');
		}
	}

	/** Remove one socket and release its expiration timer. */
	private detach(socket: WebSocket): void {
		const client = this.clients.get(socket);
		if (!client) {
			return;
		}

		if (client.expirationTimer) {
			clearTimeout(client.expirationTimer);
		}
		this.clients.delete(socket);
	}

	/** Close one client after detaching it from future broadcasts. */
	private closeClient(client: LiveEventClient, code: number, reason: string): void {
		this.detach(client.socket);
		client.socket.close(code, reason);
	}

	/** Schedule bounded timer intervals until the associated session needs durable revalidation. */
	private scheduleExpiration(client: LiveEventClient): void {
		const remainingMs = client.expiresAtMs - Date.now();
		if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
			this.closeClient(client, 1008, 'Authentication session expired');
			return;
		}

		const delayMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
		client.expirationTimer = setTimeout(() => {
			if (delayMs < remainingMs) {
				this.scheduleExpiration(client);
				return;
			}

			void this.revalidateExpiration(client);
		}, delayMs);
		client.expirationTimer.unref();
	}

	/** Recheck sliding session state before closing a socket at its previously known deadline. */
	private async revalidateExpiration(client: LiveEventClient): Promise<void> {
		if (!this.clients.has(client.socket)) {
			return;
		}
		if (!this.resolveSessionExpiry) {
			this.closeClient(client, 1008, 'Authentication session expired');
			return;
		}

		try {
			const expiresAtMs = await this.resolveSessionExpiry(client.tokenHash);
			if (!this.clients.has(client.socket)) {
				return;
			}
			if (expiresAtMs === null || expiresAtMs <= Date.now()) {
				this.closeClient(client, 1008, 'Authentication session expired');
				return;
			}

			client.expiresAtMs = expiresAtMs;
			this.scheduleExpiration(client);
		}
		catch {
			this.closeClient(client, 1013, 'Unable to verify authentication session');
		}
	}

	/** Send one bounded event only while the WebSocket remains writable. */
	private send(socket: WebSocket, event: LiveEvent): void {
		if (socket.readyState !== WEB_SOCKET_OPEN) {
			return;
		}

		if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
			socket.close(1013, 'Live event client is too slow');
			return;
		}

		socket.send(JSON.stringify(event));
	}
}
