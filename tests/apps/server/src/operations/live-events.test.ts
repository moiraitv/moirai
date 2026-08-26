import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { LiveEventHub } from '@server/operations/live-events.js';

class TestSocket extends EventEmitter {
	readonly bufferedAmount = 0;
	readonly readyState = 1;
	readonly send = vi.fn();
	readonly close = vi.fn();
	readonly terminate = vi.fn();
}

describe('LiveEventHub shutdown', () => {
	it('terminates attached sockets when immediate shutdown is requested', () => {
		const events = new LiveEventHub();
		const socket = new TestSocket();
		events.attach(socket as unknown as WebSocket);

		events.close({ terminate: true });

		expect(socket.terminate).toHaveBeenCalledOnce();
		expect(socket.close).not.toHaveBeenCalled();
	});

	it('uses a graceful close by default', () => {
		const events = new LiveEventHub();
		const socket = new TestSocket();
		events.attach(socket as unknown as WebSocket);

		events.close();

		expect(socket.close).toHaveBeenCalledWith(1001, 'Server shutting down');
		expect(socket.terminate).not.toHaveBeenCalled();
	});
});
