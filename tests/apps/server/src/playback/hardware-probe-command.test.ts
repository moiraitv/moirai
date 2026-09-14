import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runHardwareProbeCommand, hardwareProbeFailureDetail } from '@server/playback/hardware-probe-command.js';

it.each([
	['Permission denied', 'permission-denied'],
	['Operation not permitted', 'permission-denied'],
	["Unknown encoder 'h264_nvenc'", 'encoder-unavailable'],
	['Cannot load libcuda.so.1', 'driver-unavailable'],
	['CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected', 'device-missing'],
	['Unrecognized target error with private path /private/example', 'unsupported'],
])('classifies bounded process output: %s', async (message, expected) => {
	const result = await runHardwareProbeCommand({ executable: process.execPath,
		args: ['-e', `process.stderr.write(${JSON.stringify(message)}); process.exitCode = 1;`], env: {} }, 2000);
	expect(result).toBe(expected);
	expect(hardwareProbeFailureDetail(result)).not.toContain('/private/example');
});

it('preserves success and missing-executable outcomes', async () => {
	await expect(runHardwareProbeCommand({ executable: process.execPath, args: ['-e', ''], env: {} }, 2000)).resolves.toBe('supported');
	await expect(runHardwareProbeCommand({ executable: '/nonexistent/moirai-ffmpeg', args: [], env: {} }, 2000)).resolves.toBe('unavailable');
});

it('checks explicit render-node presence and permissions before launching FFmpeg', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-device-access-'));
	const device = path.join(root, 'renderD128');
	const command = { executable: process.execPath, args: ['-vaapi_device', device], env: {} };
	try {
		await expect(runHardwareProbeCommand(command, 2000)).resolves.toBe('device-missing');
		await writeFile(device, 'fixture');
		await chmod(device, 0);
		if (process.platform !== 'win32' && process.getuid?.() !== 0) {
			await expect(runHardwareProbeCommand(command, 2000)).resolves.toBe('permission-denied');
		}
	}
	finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('keeps timeout and output-limit failures generic', async () => {
	await expect(runHardwareProbeCommand({ executable: process.execPath,
		args: ['-e', 'setInterval(() => {}, 1000)'], env: {} }, 100)).resolves.toBe('unsupported');
	await expect(runHardwareProbeCommand({ executable: process.execPath,
		args: ['-e', "process.stderr.write('x'.repeat(100000))"], env: {} }, 2000)).resolves.toBe('unsupported');
});
