import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE } from '@moirai/shared';
import {
	AUTHENTICATION_PROBE_TIMEOUT_MS,
	LiveEventClient,
} from '@web/live-events.js';

/** Minimal browser WebSocket that exposes registered close handlers to focused client tests. */
class FakeWebSocket {
	static readonly instances: FakeWebSocket[] = [];
	private readonly closeListeners: Array<(event: CloseEvent) => void> = [];

	constructor(public readonly url: URL) {
		FakeWebSocket.instances.push(this);
	}

	/** Retain close handlers; other protocol handlers are irrelevant to these tests. */
	addEventListener(type: string, listener: EventListener): void {
		if (type === 'close') {
			this.closeListeners.push(listener as (event: CloseEvent) => void);
		}
	}

	/** Model the browser close method used during ordinary client shutdown. */
	close(): void {}

	/** Deliver a server close code to every registered close handler. */
	emitClose(code: number): void {
		for (const listener of this.closeListeners) {
			listener({ code } as CloseEvent);
		}
	}
}

afterEach(() => {
	FakeWebSocket.instances.length = 0;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('live-event authentication expiry', () => {
	it('stops reconnecting and notifies the application after a policy close', () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', {
			location: { href: 'http://127.0.0.1:3000/status' },
			clearTimeout,
			setTimeout,
		});
		vi.stubGlobal('WebSocket', FakeWebSocket);
		const client = new LiveEventClient();
		const expired = vi.fn();
		client.onAuthenticationExpired(expired);
		client.start();

		FakeWebSocket.instances[0]?.emitClose(1008);
		vi.advanceTimersByTime(60_000);

		expect(expired).toHaveBeenCalledOnce();
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it('reconnects without expiring authentication after intentional session replacement', () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', {
			location: { href: 'http://127.0.0.1:3000/settings' },
			clearTimeout,
			setTimeout,
		});
		vi.stubGlobal('WebSocket', FakeWebSocket);
		const client = new LiveEventClient();
		const expired = vi.fn();
		const probe = vi.fn().mockResolvedValue(false);
		client.onAuthenticationExpired(expired);
		client.onAuthenticationProbe(probe);
		client.start();

		FakeWebSocket.instances[0]?.emitClose(LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE);
		vi.advanceTimersByTime(2_000);
		FakeWebSocket.instances[1]?.emitClose(1006);
		vi.advanceTimersByTime(3_000);

		expect(expired).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(FakeWebSocket.instances).toHaveLength(3);
	});

	it('expires authentication when an abnormal failed upgrade has no valid session', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', {
			location: { href: 'http://127.0.0.1:3000/status' },
			clearTimeout,
			setTimeout,
		});
		vi.stubGlobal('WebSocket', FakeWebSocket);
		const client = new LiveEventClient();
		const expired = vi.fn();
		client.onAuthenticationExpired(expired);
		client.onAuthenticationProbe(vi.fn().mockResolvedValue(false));
		client.start();

		FakeWebSocket.instances[0]?.emitClose(1006);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(expired).toHaveBeenCalledOnce();
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it('resumes reconnecting after an authentication probe reaches its deadline', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('window', {
			location: { href: 'http://127.0.0.1:3000/status' },
			clearTimeout,
			setTimeout,
		});
		vi.stubGlobal('WebSocket', FakeWebSocket);
		const client = new LiveEventClient();
		const expired = vi.fn();
		let probeSignal: AbortSignal | undefined;
		client.onAuthenticationExpired(expired);
		client.onAuthenticationProbe((signal) => {
			probeSignal = signal;
			return new Promise(() => {});
		});
		client.start();

		FakeWebSocket.instances[0]?.emitClose(1006);
		await vi.advanceTimersByTimeAsync(AUTHENTICATION_PROBE_TIMEOUT_MS + 2_000);

		expect(probeSignal?.aborted).toBe(true);
		expect(expired).not.toHaveBeenCalled();
		expect(FakeWebSocket.instances).toHaveLength(2);
	});
});
