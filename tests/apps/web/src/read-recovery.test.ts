import { expect, it, vi } from 'vitest';
import { ApiError } from '@web/api';
import { isTransientReadFailure, readWithRetry } from '@web/read-recovery';

it('retries only network failures and temporary service responses, once', async () => {
	for (const cause of [new TypeError('Failed to fetch'), ...[502, 503, 504].map(status => new ApiError({ message: 'Unavailable', code: 'unavailable', requestId: 'test' }, status))]) {
		expect(isTransientReadFailure(cause)).toBe(true);
		const read = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue('saved');
		await expect(readWithRetry(read)).resolves.toBe('saved');
		expect(read).toHaveBeenCalledTimes(2);
	}
	for (const status of [400, 401, 403, 404, 409, 413, 429, 500]) {
		const cause = new ApiError({ message: 'Rejected', code: 'rejected', requestId: 'test' }, status);
		const read = vi.fn().mockRejectedValue(cause);
		await expect(readWithRetry(read)).rejects.toBe(cause);
		expect(read).toHaveBeenCalledTimes(1);
	}
	const read = vi.fn().mockRejectedValue(new TypeError('Offline'));
	await expect(readWithRetry(read)).rejects.toThrow('Offline');
	expect(read).toHaveBeenCalledTimes(2);
});
