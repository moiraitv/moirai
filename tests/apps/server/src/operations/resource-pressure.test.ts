import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourcePressureCoordinator } from '@server/operations/resource-pressure.js';

const coordinators: ResourcePressureCoordinator[] = [];

/** Create one coordinator owned by the current test. */
function coordinator(): ResourcePressureCoordinator {
	const instance = new ResourcePressureCoordinator();
	coordinators.push(instance);
	return instance;
}

afterEach(async () => {
	await Promise.all(coordinators.splice(0).map((instance) => instance.close()));
});

describe('ResourcePressureCoordinator', () => {
	it('sheds background resources and retries an essential operation', async () => {
		const pressure = coordinator();
		const suspendBackground = vi.fn();
		const suspendConnections = vi.fn();
		pressure.register({ name: 'background', stage: 'background', suspend: suspendBackground });
		pressure.register({ name: 'connections', stage: 'connections', suspend: suspendConnections });
		const work = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error('capacity'), { code: 'EMFILE' }))
			.mockResolvedValue('ready');

		await expect(pressure.runEssential('probe', work)).resolves.toBe('ready');
		expect(work).toHaveBeenCalledTimes(2);
		expect(suspendBackground).toHaveBeenCalledOnce();
		expect(suspendConnections).not.toHaveBeenCalled();
		expect(pressure.health().status).toBe('degraded');
	});

	it('releases live connections only after the background retry also exhausts resources', async () => {
		const pressure = coordinator();
		const calls: string[] = [];
		pressure.register({
			name: 'background',
			stage: 'background',
			suspend: () => {
				calls.push('background');
			},
		});
		pressure.register({
			name: 'connections',
			stage: 'connections',
			suspend: () => {
				calls.push('connections');
			},
		});
		const exhausted = () => Object.assign(new Error('capacity'), { code: 'ENFILE' });
		const work = vi.fn()
			.mockRejectedValueOnce(exhausted())
			.mockRejectedValueOnce(exhausted())
			.mockResolvedValue('ready');

		await expect(pressure.runEssential('playback', work)).resolves.toBe('ready');
		expect(calls).toEqual(['background', 'connections']);
		expect(work).toHaveBeenCalledTimes(3);
	});

	it('does not retry ordinary domain failures', async () => {
		const pressure = coordinator();
		const suspend = vi.fn();
		pressure.register({ name: 'background', stage: 'background', suspend });
		const work = vi.fn().mockRejectedValue(new Error('invalid media'));

		await expect(pressure.runEssential('probe', work)).rejects.toThrow('invalid media');
		expect(work).toHaveBeenCalledOnce();
		expect(suspend).not.toHaveBeenCalled();
	});
});
