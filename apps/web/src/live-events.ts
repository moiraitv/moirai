import { liveEventSchema, type LiveEvent } from '@moirai/shared';

/** Callback registered for one typed server event. */
type LiveEventListener = (event: LiveEvent) => void;

/** Reconnecting client for the versioned server event stream. */
class LiveEventClient {
	private readonly listeners = new Set<LiveEventListener>();
	private socket: WebSocket | null = null;
	private reconnectTimer: number | undefined;
	private retryAttempt = 0;
	private running = false;

	/** Start the shared WebSocket connection. */
	start(): void {
		if (this.running) {
			return;
		}

		this.running = true;
		this.connect();
	}

	/** Stop reconnecting and close the active WebSocket. */
	stop(): void {
		this.running = false;
		window.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.socket?.close(1000, 'Page closing');
		this.socket = null;
	}

	/** Register an event listener and return its unsubscribe callback. */
	subscribe(listener: LiveEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Open the WebSocket when the client is running and disconnected. */
	private connect(): void {
		if (!this.running || this.socket) {
			return;
		}

		const url = new URL('/api/v1/events', window.location.href);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		const socket = new WebSocket(url);
		this.socket = socket;

		socket.addEventListener('open', () => {
			this.retryAttempt = 0;
		});
		socket.addEventListener('message', (message) => {
			if (typeof message.data !== 'string') {
				return;
			}

			try {
				const parsed = liveEventSchema.safeParse(JSON.parse(message.data));
				if (parsed.success) {
					for (const listener of this.listeners) {
						listener(parsed.data);
					}
				}
			}
			catch {
				// Invalid or future protocol messages are ignored safely.
			}
		});
		socket.addEventListener('close', () => {
			if (this.socket === socket) {
				this.socket = null;
			}
			this.scheduleReconnect();
		});
		socket.addEventListener('error', () => socket.close());
	}

	/** Queue one reconnect attempt with bounded exponential backoff. */
	private scheduleReconnect(): void {
		if (!this.running || this.reconnectTimer !== undefined) {
			return;
		}

		const delay = Math.min(30_000, 1_000 * 2 ** this.retryAttempt) + Math.random() * 250;
		this.retryAttempt = Math.min(this.retryAttempt + 1, 5);
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
	}
}

/** Module-level live events value for live events. */
export const liveEvents = new LiveEventClient();
