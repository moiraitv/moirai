import { describe, expect, it, vi } from 'vitest';
import { listenWithAddressRetry } from '@server/listen.js';

describe('listenWithAddressRetry', () => {
	it('waits for a development port to be released', async () => {
		const addressInUse = Object.assign(new Error('busy'), { code: 'EADDRINUSE' });
		const listen = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(addressInUse)
			.mockRejectedValueOnce(addressInUse)
			.mockResolvedValue();
		const onRetry = vi.fn();

		await listenWithAddressRetry(listen, { attempts: 3, delayMs: 0, onRetry });

		expect(listen).toHaveBeenCalledTimes(3);
		expect(onRetry).toHaveBeenCalledTimes(2);
	});

	it('does not hide unrelated startup failures', async () => {
		const failure = new Error('database unavailable');
		const listen = vi.fn<() => Promise<void>>().mockRejectedValue(failure);

		await expect(listenWithAddressRetry(listen, { attempts: 3, delayMs: 0 })).rejects.toBe(failure);
		expect(listen).toHaveBeenCalledOnce();
	});
});
