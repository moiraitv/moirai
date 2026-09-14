import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { HardwareAccelerationPredictionRequest } from '@moirai/shared/api-contracts';
import {
	buildHardwareCandidates,
	HardwareAccelerationResolver,
	type HardwareAccelerationEnvironment,
	type HardwareProbeCommand,
} from '@server/playback/hardware-acceleration.js';

const request = (
	overrides: Partial<HardwareAccelerationPredictionRequest> = {},
): HardwareAccelerationPredictionRequest => ({
	format: 'h264',
	bitDepth: 8,
	width: 1920,
	height: 1080,
	vaapiDevice: null,
	vaapiDriver: null,
	ffmpegPath: null,
	...overrides,
});

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
} as unknown as FastifyBaseLogger;

describe('HardwareAccelerationResolver', () => {
	it('prefers discrete Linux devices before integrated backends', () => {
		const candidates = buildHardwareCandidates(request(), 'linux', 'x64', [
			{ path: '/dev/dri/renderD128', drivers: ['ihd'], discrete: false },
			{ path: '/dev/dri/renderD129', drivers: ['radeonsi'], discrete: true },
		]);
		expect(candidates.map((candidate) => candidate.accel)).toEqual([
			'cuda',
			'vaapi',
			'qsv',
			'vaapi',
			'vulkan',
		]);
		expect(candidates[1]).toMatchObject({
			vaapiDevice: '/dev/dri/renderD129',
			vaapiDriver: 'radeonsi',
		});
	});

	it('uses the first backend that encodes the configured target', async () => {
		const commands: HardwareProbeCommand[] = [];
		const environment: HardwareAccelerationEnvironment = {
			platform: 'linux',
			arch: 'x64',
			listVaapiDevices: async () => [],
			runCommand: async (command) => {
				commands.push(command);
				return command.args.includes('hevc_qsv') ? 'supported' : 'unsupported';
			},
		};
		const resolver = new HardwareAccelerationResolver(logger, environment);
		const result = await resolver.resolve(request({ format: 'hevc', bitDepth: 10 }));
		expect(result).toMatchObject({ outcome: 'hardware', accel: 'qsv' });
		expect(commands).toHaveLength(2);
		expect(commands[1]?.args).toContain('format=p010le,hwupload');
		expect(commands[1]?.args).toContain('color=c=black:s=1920x1080:r=1');
	});

	it('coalesces identical requests and caches their result', async () => {
		const runCommand = vi.fn(async () => 'supported' as const);
		const resolver = new HardwareAccelerationResolver(logger, {
			platform: 'darwin',
			arch: 'arm64',
			listVaapiDevices: async () => [],
			runCommand,
		});
		const [first, second] = await Promise.all([
			resolver.resolve(request()),
			resolver.resolve(request()),
		]);
		const third = await resolver.resolve(request());
		expect(first.accel).toBe('videotoolbox');
		expect(second).toEqual(first);
		expect(third).toEqual(first);
		expect(runCommand).toHaveBeenCalledTimes(1);
	});

	it('reports an unavailable FFmpeg executable as indeterminate', async () => {
		let attempt = 0;
		const resolver = new HardwareAccelerationResolver(logger, {
			platform: 'darwin',
			arch: 'arm64',
			listVaapiDevices: async () => [],
			runCommand: async () => ++attempt === 1 ? 'unavailable' : 'supported',
		});
		await expect(resolver.resolve(request())).resolves.toMatchObject({
			outcome: 'indeterminate',
			accel: null,
		});
		await expect(resolver.resolve(request())).resolves.toMatchObject({
			outcome: 'hardware',
			accel: 'videotoolbox',
		});
		expect(attempt).toBe(2);
	});

	it('does not probe source-sized output with invented dimensions', async () => {
		const runCommand = vi.fn(async () => 'supported' as const);
		const resolver = new HardwareAccelerationResolver(logger, {
			platform: 'darwin',
			arch: 'arm64',
			listVaapiDevices: async () => [],
			runCommand,
		});
		await expect(resolver.resolve(request({ width: null }))).resolves.toMatchObject({
			outcome: 'indeterminate',
			accel: null,
		});
		await expect(resolver.resolve(request({ height: null }))).resolves.toMatchObject({
			outcome: 'indeterminate',
			accel: null,
		});
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('bounds time spent waiting behind a distinct probe target', async () => {
		vi.useFakeTimers();
		let releaseFirst: (result: 'supported') => void = () => undefined;
		let attempt = 0;
		const resolver = new HardwareAccelerationResolver(logger, {
			platform: 'darwin',
			arch: 'arm64',
			listVaapiDevices: async () => [],
			runCommand: async () => {
				attempt += 1;
				if (attempt === 1) {
					return new Promise<'supported'>((resolve) => {
						releaseFirst = resolve;
					});
				}
				return 'supported';
			},
		});
		try {
			const first = resolver.resolve(request({ width: 1920 }));
			await vi.advanceTimersByTimeAsync(0);
			const waiting = resolver.resolve(request({ width: 1280 }));
			await vi.advanceTimersByTimeAsync(8_001);
			await expect(waiting).resolves.toMatchObject({
				outcome: 'indeterminate',
				accel: null,
			});
			releaseFirst('supported');
			await expect(first).resolves.toMatchObject({ outcome: 'indeterminate' });
			expect(attempt).toBe(1);
		}
		finally {
			vi.useRealTimers();
		}
	});

	it('falls back to None for unsupported bit depths and oversized targets', async () => {
		const runCommand = vi.fn(async () => 'supported' as const);
		const resolver = new HardwareAccelerationResolver(logger, {
			platform: 'darwin',
			arch: 'arm64',
			listVaapiDevices: async () => [],
			runCommand,
		});
		await expect(resolver.resolve(request({ bitDepth: 12 }))).resolves.toMatchObject({
			outcome: 'none',
			accel: null,
		});
		await expect(resolver.resolve(request({ width: 7681, height: 4320 }))).resolves.toMatchObject({
			outcome: 'none',
			accel: null,
		});
		expect(runCommand).not.toHaveBeenCalled();
	});
});

it('reports setup failures per backend without suppressing later successful backends', async () => {
	const resolver = new HardwareAccelerationResolver(logger, {
		platform: 'linux', arch: 'x64', listVaapiDevices: async () => [],
		runCommand: async command => command.args.includes('h264_nvenc') ? 'device-missing' : 'encoder-unavailable',
	});
	const result = await resolver.resolve(request());
	expect(result.outcome).toBe('none');
	expect(result.detail).toContain('CUDA: Device missing');
	expect(result.detail).toContain('QSV: Encoder unavailable');
	const working = new HardwareAccelerationResolver(logger, {
		platform: 'linux', arch: 'x64', listVaapiDevices: async () => [],
		runCommand: async command => command.args.includes('h264_nvenc') ? 'permission-denied' : 'supported',
	});
	await expect(working.resolve(request())).resolves.toMatchObject({ outcome: 'hardware', accel: 'qsv' });
});

it('does not misreport denied device discovery as missing hardware', async () => {
	const resolver = new HardwareAccelerationResolver(logger, {
		platform: 'linux', arch: 'x64',
		listVaapiDevices: async () => {
			throw Object.assign(new Error('private path'), { code: 'EACCES' });
		},
		runCommand: async () => 'unsupported',
	});
	const result = await resolver.resolve(request());
	expect(result.detail).toContain('Permission denied');
	expect(result.detail).not.toContain('Device missing');
	expect(result.detail).not.toContain('private path');
});
