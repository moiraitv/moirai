import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE } from '@moirai/shared';
import type { AuthenticationSessionRecord } from '@server/auth/contracts.js';
import { LiveEventHub } from '@server/operations/live-events.js';

class TestSocket extends EventEmitter {
	readonly bufferedAmount = 0;
	readonly readyState = 1;
	readonly send = vi.fn();
	readonly close = vi.fn();
	readonly terminate = vi.fn();
}

function session(
	tokenHash = 'session-hash',
	expiresAt = new Date(Date.now() + 60_000).toISOString(),
): AuthenticationSessionRecord {
	return {
		tokenHash,
		identity: {
			id: '7a991697-cfba-4f2d-9f7d-f67204ff83c2',
			provider: 'local',
			displayName: 'Administrator',
			username: 'administrator',
		},
		csrfToken: 'csrf',
		providerSessionId: null,
		providerLogoutHint: null,
		providerConfigurationHash: null,
		createdAt: new Date().toISOString(),
		lastSeenAt: new Date().toISOString(),
		expiresAt,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('LiveEventHub shutdown', () => {
	it('terminates attached sockets when immediate shutdown is requested', () => {
		const events = new LiveEventHub();
		const socket = new TestSocket();
		events.attach(socket as unknown as WebSocket, session());

		events.close({ terminate: true });

		expect(socket.terminate).toHaveBeenCalledOnce();
		expect(socket.close).not.toHaveBeenCalled();
	});

	it('uses a graceful close by default', () => {
		const events = new LiveEventHub();
		const socket = new TestSocket();
		events.attach(socket as unknown as WebSocket, session());

		events.close();

		expect(socket.close).toHaveBeenCalledWith(1001, 'Server shutting down');
		expect(socket.terminate).not.toHaveBeenCalled();
	});

	it('closes only sockets associated with revoked session hashes', () => {
		const events = new LiveEventHub();
		const revoked = new TestSocket();
		const retained = new TestSocket();
		events.attach(revoked as unknown as WebSocket, session('revoked'));
		events.attach(retained as unknown as WebSocket, session('retained'));

		events.revokeSessions(['revoked']);

		expect(revoked.close).toHaveBeenCalledWith(1008, 'Authentication session ended');
		expect(retained.close).not.toHaveBeenCalled();
		events.close({ terminate: true });
	});

	it('requests a reconnect instead of expiry handling for an intentionally replaced session', () => {
		const events = new LiveEventHub();
		const socket = new TestSocket();
		events.attach(socket as unknown as WebSocket, session('replaced'));

		events.replaceSessions(['replaced']);

		expect(socket.close).toHaveBeenCalledWith(
			LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE,
			'Authentication session replaced',
		);
	});

	it('rejects a socket whose associated session has already expired', () => {
		const events = new LiveEventHub();
		const socket = new TestSocket();
		events.attach(
			socket as unknown as WebSocket,
			session('expired', new Date(Date.now() - 1).toISOString()),
		);

		expect(socket.close).toHaveBeenCalledWith(1008, 'Authentication session expired');
		expect(socket.send).not.toHaveBeenCalled();
	});

	it('revalidates and reschedules a sliding session before closing its socket', async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const resolveExpiry = vi.fn()
			.mockResolvedValueOnce(now + 60_000)
			.mockResolvedValueOnce(null);
		const events = new LiveEventHub(resolveExpiry);
		const socket = new TestSocket();
		events.attach(
			socket as unknown as WebSocket,
			session('sliding', new Date(now + 1_000).toISOString()),
		);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(resolveExpiry).toHaveBeenNthCalledWith(1, 'sliding');
		expect(socket.close).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(59_000);
		expect(resolveExpiry).toHaveBeenNthCalledWith(2, 'sliding');
		expect(socket.close).toHaveBeenCalledWith(1008, 'Authentication session expired');
	});
});
