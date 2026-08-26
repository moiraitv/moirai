import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
	LIVE_EVENT_PROTOCOL_VERSION,
	liveEventSchema,
	type LiveEvent,
	type LiveEventInput,
} from '@moirai/shared';
import { currentTimestamp } from '../time.js';

/** Bound live events resource use for clients. */
const MAX_CLIENTS = 100;
/** Bound live events resource use for buffered bytes. */
const MAX_BUFFERED_BYTES = 256 * 1024;
/** WebSocket ready-state value indicating a writable connection. */
const WEB_SOCKET_OPEN = 1;

/** Minimal event publisher used to decouple services from the WebSocket transport. */
export interface LiveEventPublisher {
	publish(event: LiveEventInput): void;
}

/** Shutdown options for connected live-event clients. */
export interface CloseLiveEventOptions {
	/** End sockets immediately so a process restart cannot remain blocked on close handshakes. */
	terminate?: boolean;
}

/**
 * Publish validated, bounded change notifications to internal listeners and WebSocket clients. The
 * hub rejects excess or slow connections and deliberately leaves REST as the authoritative recovery
 * path after reconnecting.
 */
export class LiveEventHub implements LiveEventPublisher {
	private readonly clients = new Set<WebSocket>();
	private readonly listeners = new Set<(event: LiveEvent) => void>();

	/** Observe authoritative change events inside the server without opening a WebSocket. */
	subscribe(listener: (event: LiveEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Attach a WebSocket client and send the initial connection event. */
	attach(socket: WebSocket): void {
		if (this.clients.size >= MAX_CLIENTS) {
			socket.close(1013, 'Too many live event connections');
			return;
		}

		this.clients.add(socket);
		socket.on('close', () => this.clients.delete(socket));
		socket.on('error', () => this.clients.delete(socket));
		// The stream is server-push-only for now. Reading prevents inbound backpressure.
		socket.on('message', () => undefined);
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
		for (const client of this.clients) {
			this.send(client, event);
		}
	}

	/** Close every live-event connection with the supplied WebSocket status. */
	close(options: CloseLiveEventOptions = {}): void {
		for (const client of this.clients) {
			if (options.terminate) {
				client.terminate();
			}
			else {
				client.close(1001, 'Server shutting down');
			}
		}
		this.clients.clear();
	}

	/** Release live-status sockets under severe pressure; clients reconnect through normal retry logic. */
	releaseConnections(): void {
		for (const client of this.clients) {
			client.close(1013, 'Server resource pressure; reconnect shortly');
		}
		this.clients.clear();
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
