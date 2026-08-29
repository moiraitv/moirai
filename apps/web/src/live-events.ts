import {
	LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE,
	liveEventSchema,
	type LiveEvent,
} from '@moirai/shared';

/** Callback registered for one typed server event. */
type LiveEventListener = (event: LiveEvent) => void;

/** Callback notified when the server terminates live events because authentication ended. */
type AuthenticationExpiredListener = () => void;

/** Callback that checks whether an abnormal transport failure still has an authenticated session. */
type AuthenticationProbe = (signal: AbortSignal) => Promise<boolean | null>;

/** Grace period for the replacement response cookie to arrive before probing session state. */
const SESSION_REPLACEMENT_GRACE_MS = 10_000;
/** Deadline before an inconclusive HTTP session probe yields back to transport reconnection. */
export const AUTHENTICATION_PROBE_TIMEOUT_MS = 5_000;

/** Reconnecting client for the versioned server event stream. */
export class LiveEventClient {
	private readonly listeners = new Set<LiveEventListener>();
	private socket: WebSocket | null = null;
	private reconnectTimer: number | undefined;
	private retryAttempt = 0;
	private running = false;
	private replacementGraceUntilMs = 0;
	private authenticationExpiredListener: AuthenticationExpiredListener | null = null;
	private authenticationProbe: AuthenticationProbe | null = null;

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
		this.replacementGraceUntilMs = 0;
	}

	/** Register an event listener and return its unsubscribe callback. */
	subscribe(listener: LiveEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Observe terminal authentication closure without coupling this transport to application state. */
	onAuthenticationExpired(listener: AuthenticationExpiredListener | null): void {
		this.authenticationExpiredListener = listener;
	}

	/** Register the authoritative session probe used after abnormal connection failures. */
	onAuthenticationProbe(probe: AuthenticationProbe | null): void {
		this.authenticationProbe = probe;
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
			this.replacementGraceUntilMs = 0;
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
		socket.addEventListener('close', (event) => {
			if (this.socket === socket) {
				this.socket = null;
			}

			if (event.code === 1008) {
				this.running = false;
				window.clearTimeout(this.reconnectTimer);
				this.reconnectTimer = undefined;
				this.authenticationExpiredListener?.();
				return;
			}
			if (event.code === LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE) {
				this.retryAttempt = 0;
				this.replacementGraceUntilMs = Date.now() + SESSION_REPLACEMENT_GRACE_MS;
			}
			if (
				event.code === 1006
				&& this.authenticationProbe
				&& Date.now() >= this.replacementGraceUntilMs
			) {
				void this.verifyAuthentication();
				return;
			}

			this.scheduleReconnect();
		});
		socket.addEventListener('error', () => socket.close());
	}

	/** Probe session state before retrying an abnormally rejected or interrupted connection. */
	private async verifyAuthentication(): Promise<void> {
		let authenticated: boolean | null = null;
		const controller = new AbortController();
		let timeout: number | undefined;
		try {
			const deadline = new Promise<null>((resolve) => {
				timeout = window.setTimeout(() => {
					controller.abort();
					resolve(null);
				}, AUTHENTICATION_PROBE_TIMEOUT_MS);
			});
			authenticated = await Promise.race([
				this.authenticationProbe?.(controller.signal) ?? Promise.resolve(null),
				deadline,
			]);
		}
		catch {
			// A failed HTTP probe is a transient network condition and retains reconnect behavior.
		}
		finally {
			window.clearTimeout(timeout);
		}

		if (!this.running || this.socket) {
			return;
		}
		if (authenticated === false) {
			this.running = false;
			this.authenticationExpiredListener?.();
			return;
		}

		this.scheduleReconnect();
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
