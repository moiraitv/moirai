import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { HardwareProbeCommand, HardwareProbeCommandResult } from './hardware-acceleration.js';

/** Maximum combined output retained before terminating a diagnostic process. */
const MAX_PROBE_OUTPUT_BYTES = 64 * 1_024;

/** Classify recognized FFmpeg failures without returning raw process output to clients. */
export function classifyHardwareProbeFailure(stderr: string): HardwareProbeCommandResult {
	if (/permission denied|operation not permitted/i.test(stderr)) {
		return 'permission-denied';
	}
	if (/unknown encoder|encoder .* not found|encoder not found/i.test(stderr)) {
		return 'encoder-unavailable';
	}
	if (/cannot load libcuda|cannot load libnvidia|failed to (?:load|open).*driver/i.test(stderr)) {
		return 'driver-unavailable';
	}
	if (/no cuda-capable device|CUDA_ERROR_NO_DEVICE|no (?:va display|device) found|no available devices/i.test(stderr)) {
		return 'device-missing';
	}
	return 'unsupported';
}

/** Explain a failed probe with a concrete setup action and no untrusted diagnostic text. */
export function hardwareProbeFailureDetail(result: HardwareProbeCommandResult): string {
	switch (result) {
		case 'device-missing':
			return 'Device missing. Check the GPU device mapping or NVIDIA Container Toolkit configuration, then recreate the container.';
		case 'permission-denied':
			return 'Permission denied. Give the container user the host device’s numeric group ID with group_add and check host device-access policies.';
		case 'encoder-unavailable':
			return 'Encoder unavailable. The configured FFmpeg build does not include this encoder. Use a compatible build or another acceleration option.';
		case 'driver-unavailable':
			return 'Driver unavailable. Check the host GPU driver and container runtime libraries; NVIDIA requires the NVIDIA Container Toolkit.';
		default:
			return 'The encode check failed or timed out. This does not establish whether device access, driver support, or the selected video target caused the failure.';
	}
}

/** Execute a smoke test with bounded output and runtime, checking explicit render-node access first. */
export async function runHardwareProbeCommand(command: HardwareProbeCommand, timeoutMs: number): Promise<HardwareProbeCommandResult> {
	const deviceIndex = command.args.indexOf('-vaapi_device');
	const device = deviceIndex >= 0 ? command.args[deviceIndex + 1] : undefined;
	if (device) {
		try {
			await access(device, constants.R_OK | constants.W_OK);
		}
		catch (cause) {
			const code = (cause as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				return 'device-missing';
			}
			if (code === 'EACCES' || code === 'EPERM') {
				return 'permission-denied';
			}
		}
	}
	return new Promise((resolve) => {
		let settled = false;
		let outputBytes = 0;
		let stderr = '';
		const child = spawn(command.executable, command.args, {
			env: { ...process.env, ...command.env }, stdio: ['ignore', 'pipe', 'pipe'],
		});
		const finish = (result: HardwareProbeCommandResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const collect = (chunk: Buffer, isError: boolean): void => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
				child.kill('SIGKILL');
				finish('unsupported');
				return;
			}
			if (isError) {
				stderr += chunk.toString('utf8');
			}
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish('unsupported');
		}, timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => collect(chunk, false));
		child.stderr.on('data', (chunk: Buffer) => collect(chunk, true));
		child.once('error', () => finish('unavailable'));
		child.once('close', (code) => finish(code === 0 ? 'supported' : classifyHardwareProbeFailure(stderr)));
	});
}
