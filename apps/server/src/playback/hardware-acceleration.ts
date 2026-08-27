import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type {
	ConcreteHardwareAcceleration,
} from '@moirai/shared';
import type {
	HardwareAccelerationPrediction,
	HardwareAccelerationPredictionRequest,
} from '@moirai/shared/api-contracts';

/** Longest time spent attempting one hardware backend. */
const CANDIDATE_TIMEOUT_MS = 2_000;
/** Overall deadline for one uncached automatic-acceleration decision. */
const RESOLUTION_TIMEOUT_MS = 8_000;
/** Time for which one hardware result may be reused. */
const CACHE_TTL_MS = 5 * 60_000;
/** Maximum distinct target results retained by the resolver. */
const MAX_CACHE_ENTRIES = 32;
/** Maximum distinct active or queued targets retained by the resolver. */
const MAX_PENDING_RESOLUTIONS = 8;
/** Maximum diagnostic process output retained before a probe is terminated. */
const MAX_PROBE_OUTPUT_BYTES = 64 * 1_024;
/** Largest frame allocation permitted for an automatic hardware smoke test. */
const MAX_PROBE_PIXELS = 7_680 * 4_320;

/** VAAPI driver names accepted by Moirai's channel contract. */
type VaapiDriver = NonNullable<HardwareAccelerationPredictionRequest['vaapiDriver']>;

/** Runtime values required to pass one verified backend to the playback worker. */
export interface HardwareAccelerationResolution extends HardwareAccelerationPrediction {
	vaapiDevice: string | null;
	vaapiDriver: VaapiDriver | null;
}

/** One executable FFmpeg probe with any backend-specific environment. */
export interface HardwareProbeCommand {
	executable: string;
	args: string[];
	env: Record<string, string>;
}

/** Outcome of attempting to launch and complete one hardware probe command. */
export type HardwareProbeCommandResult = 'supported' | 'unsupported' | 'unavailable';

/** Execute one bounded FFmpeg command without invoking a shell. */
export type HardwareProbeCommandRunner = (
	command: HardwareProbeCommand,
	timeoutMs: number,
) => Promise<HardwareProbeCommandResult>;

/** Linux VAAPI render node and the driver families worth trying with it. */
export interface VaapiRenderDevice {
	path: string;
	drivers: VaapiDriver[];
	discrete: boolean;
}

/** Platform facts and process seam used to make hardware probing deterministic in tests. */
export interface HardwareAccelerationEnvironment {
	platform: NodeJS.Platform;
	arch: string;
	listVaapiDevices: () => Promise<VaapiRenderDevice[]>;
	runCommand: HardwareProbeCommandRunner;
}

/** Internal backend candidate including worker configuration recovered after a successful probe. */
interface HardwareCandidate {
	accel: ConcreteHardwareAcceleration;
	label: string;
	initArgs: string[];
	filterArgs: string[];
	env: Record<string, string>;
	vaapiDevice: string | null;
	vaapiDriver: VaapiDriver | null;
}

/** Cached automatic selection and its absolute expiration time. */
interface CachedResolution {
	expiresAt: number;
	resolution: HardwareAccelerationResolution;
}

/** Return the FFmpeg encoder name used by one concrete backend and target codec. */
function encoderName(
	accel: ConcreteHardwareAcceleration,
	format: HardwareAccelerationPredictionRequest['format'],
): string {
	const prefix = format === 'hevc' ? 'hevc' : 'h264';
	const suffix: Record<ConcreteHardwareAcceleration, string> = {
		amf: 'amf',
		cuda: 'nvenc',
		qsv: 'qsv',
		rkmpp: 'rkmpp',
		vaapi: 'vaapi',
		videotoolbox: 'videotoolbox',
		vulkan: 'vulkan',
	};
	return `${prefix}_${suffix[accel]}`;
}

/** Return the user-facing name for one concrete acceleration backend. */
export function hardwareAccelerationLabel(accel: ConcreteHardwareAcceleration): string {
	const labels: Record<ConcreteHardwareAcceleration, string> = {
		amf: 'AMF',
		cuda: 'CUDA',
		qsv: 'QSV',
		rkmpp: 'RKMPP',
		vaapi: 'VAAPI',
		videotoolbox: 'VideoToolbox',
		vulkan: 'Vulkan',
	};
	return labels[accel];
}

/** Build a backend candidate whose software input is uploaded to a named hardware device. */
function uploadedCandidate(
	accel: ConcreteHardwareAcceleration,
	initArgs: string[],
): HardwareCandidate {
	return {
		accel,
		label: hardwareAccelerationLabel(accel),
		initArgs,
		filterArgs: ['-vf', 'format=nv12,hwupload'],
		env: {},
		vaapiDevice: null,
		vaapiDriver: null,
	};
}

/** Build one VAAPI device/driver candidate with the environment expected by FFmpeg and Next. */
function vaapiCandidate(device: string, driver: VaapiDriver): HardwareCandidate {
	const driverEnvironment = driver === 'ihd' ? 'iHD' : driver;
	return {
		accel: 'vaapi',
		label: `VAAPI (${path.basename(device)}, ${driverEnvironment})`,
		initArgs: ['-vaapi_device', device],
		filterArgs: ['-vf', 'format=nv12,hwupload'],
		env: { LIBVA_DRIVER_NAME: driverEnvironment },
		vaapiDevice: device,
		vaapiDriver: driver,
	};
}

/** Append VAAPI candidates without retrying an identical device and driver pair. */
function appendVaapiCandidates(
	target: HardwareCandidate[],
	devices: VaapiRenderDevice[],
	seen: Set<string>,
): void {
	for (const device of devices) {
		for (const driver of device.drivers) {
			const key = `${device.path}\0${driver}`;
			if (!seen.has(key)) {
				seen.add(key);
				target.push(vaapiCandidate(device.path, driver));
			}
		}
	}
}

/** Order concrete backend probes for the current operating system and visible Linux devices. */
export function buildHardwareCandidates(
	request: HardwareAccelerationPredictionRequest,
	platform: NodeJS.Platform,
	arch: string,
	vaapiDevices: VaapiRenderDevice[],
): HardwareCandidate[] {
	if (platform === 'darwin') {
		return [{
			accel: 'videotoolbox',
			label: 'VideoToolbox',
			initArgs: ['-init_hw_device', 'videotoolbox'],
			filterArgs: ['-pix_fmt', 'TARGET_PIXEL_FORMAT'],
			env: {},
			vaapiDevice: null,
			vaapiDriver: null,
		}];
	}

	const candidates: HardwareCandidate[] = [];
	if (platform === 'win32') {
		candidates.push(uploadedCandidate('cuda', ['-init_hw_device', 'cuda=hw', '-filter_hw_device', 'hw']));
		candidates.push({
			...uploadedCandidate('amf', []),
			filterArgs: ['-pix_fmt', 'TARGET_PIXEL_FORMAT'],
		});
		candidates.push(uploadedCandidate('qsv', ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw']));
		candidates.push(uploadedCandidate('vulkan', [
			'-init_hw_device', 'vulkan=hw', '-filter_hw_device', 'hw',
		]));
		return candidates;
	}

	if (platform !== 'linux') {
		return candidates;
	}

	const seenVaapi = new Set<string>();
	if (request.vaapiDevice && request.vaapiDriver) {
		appendVaapiCandidates(candidates, [{
			path: request.vaapiDevice,
			drivers: [request.vaapiDriver],
			discrete: false,
		}], seenVaapi);
	}

	candidates.push(uploadedCandidate('cuda', ['-init_hw_device', 'cuda=hw', '-filter_hw_device', 'hw']));
	appendVaapiCandidates(
		candidates,
		vaapiDevices.filter((device) => device.discrete),
		seenVaapi,
	);
	candidates.push(uploadedCandidate('qsv', ['-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw']));
	if (arch === 'arm64' || arch === 'arm') {
		candidates.push(uploadedCandidate('rkmpp', [
			'-init_hw_device', 'rkmpp=hw', '-filter_hw_device', 'hw',
		]));
	}
	appendVaapiCandidates(
		candidates,
		vaapiDevices.filter((device) => !device.discrete),
		seenVaapi,
	);
	candidates.push(uploadedCandidate('vulkan', [
		'-init_hw_device', 'vulkan=hw', '-filter_hw_device', 'hw',
	]));
	return candidates;
}

/** Normalize a Linux PCI vendor identifier read from sysfs. */
function normalizedVendor(value: string): string {
	return value.trim().toLowerCase().replace(/^0x/u, '');
}

/** Discover render nodes and likely VAAPI drivers without opening a media device. */
export async function listLinuxVaapiDevices(): Promise<VaapiRenderDevice[]> {
	let entries: string[];
	try {
		entries = await readdir('/dev/dri');
	}
	catch {
		return [];
	}

	const devices = await Promise.all(entries
		.filter((entry) => /^renderD\d+$/u.test(entry))
		.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
		.map(async (entry): Promise<VaapiRenderDevice> => {
			let vendor = '';
			try {
				vendor = normalizedVendor(await readFile(`/sys/class/drm/${entry}/device/vendor`, 'utf8'));
			}
			catch {
				// Non-PCI render nodes can still expose a working VAAPI implementation.
			}

			if (vendor === '1002') {
				return { path: `/dev/dri/${entry}`, drivers: ['radeonsi'], discrete: true };
			}
			if (vendor === '8086') {
				return { path: `/dev/dri/${entry}`, drivers: ['ihd', 'i965'], discrete: false };
			}
			return {
				path: `/dev/dri/${entry}`,
				drivers: ['ihd', 'i965', 'radeonsi'],
				discrete: false,
			};
		}));
	return devices.sort((left, right) => Number(right.discrete) - Number(left.discrete));
}

/** Execute a probe while bounding runtime and diagnostic output. */
export function runHardwareProbeCommand(
	command: HardwareProbeCommand,
	timeoutMs: number,
): Promise<HardwareProbeCommandResult> {
	return new Promise((resolve) => {
		let settled = false;
		let outputBytes = 0;
		const child = spawn(command.executable, command.args, {
			env: { ...process.env, ...command.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const finish = (result: HardwareProbeCommandResult): void => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const collect = (chunk: Buffer): void => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
				child.kill('SIGKILL');
				finish('unsupported');
			}
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish('unsupported');
		}, timeoutMs);
		child.stdout.on('data', collect);
		child.stderr.on('data', collect);
		child.once('error', () => finish('unavailable'));
		child.once('exit', (code) => finish(code === 0 ? 'supported' : 'unsupported'));
	});
}

/** Resolve Moirai's automatic setting using the hardware visible to the server process. */
export class HardwareAccelerationResolver {
	private readonly cache = new Map<string, CachedResolution>();
	private readonly pending = new Map<string, Promise<HardwareAccelerationResolution>>();
	private probeQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly logger: FastifyBaseLogger,
		private readonly environment: HardwareAccelerationEnvironment = {
			platform: process.platform,
			arch: process.arch,
			listVaapiDevices: listLinuxVaapiDevices,
			runCommand: runHardwareProbeCommand,
		},
	) {}

	/** Return a cached decision or serialize one bounded hardware probe operation. */
	async resolve(
		request: HardwareAccelerationPredictionRequest,
	): Promise<HardwareAccelerationResolution> {
		const key = JSON.stringify(request);
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.resolution;
		}

		const active = this.pending.get(key);
		if (active) {
			return active;
		}
		if (this.pending.size >= MAX_PENDING_RESOLUTIONS) {
			return this.indeterminate('The automatic hardware probe queue is currently full.');
		}

		const deadline = Date.now() + RESOLUTION_TIMEOUT_MS;
		const operation = this.resolveSerialized(request, deadline)
			.finally(() => this.pending.delete(key));
		this.pending.set(key, operation);
		return operation;
	}

	/** Wait only until the request deadline for the preceding serialized probe target. */
	private async waitForProbeTurn(previous: Promise<void>, deadline: number): Promise<boolean> {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return false;
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), remaining);
		});
		const acquired = await Promise.race([
			previous.then(() => true),
			timedOut,
		]);
		clearTimeout(timer);
		return acquired;
	}

	/** Serialize one target while including queue time in its bounded resolution deadline. */
	private async resolveSerialized(
		request: HardwareAccelerationPredictionRequest,
		deadline: number,
	): Promise<HardwareAccelerationResolution> {
		let release = (): void => undefined;
		const previous = this.probeQueue;
		this.probeQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		const acquired = await this.waitForProbeTurn(previous, deadline);
		if (!acquired) {
			void previous.then(release);
			return this.indeterminate(
				'Hardware support could not be determined before the probe queue deadline.',
			);
		}

		try {
			const resolution = await this.probe(request, deadline);
			if (resolution.outcome !== 'indeterminate') {
				this.cache.set(JSON.stringify(request), {
					expiresAt: Date.now() + CACHE_TTL_MS,
					resolution,
				});
				while (this.cache.size > MAX_CACHE_ENTRIES) {
					const oldest = this.cache.keys().next().value;
					if (oldest === undefined) {
						break;
					}
					this.cache.delete(oldest);
				}
			}
			return resolution;
		}
		finally {
			release();
		}
	}

	/** Try platform candidates until one completes a target-specific hardware encode. */
	private async probe(
		request: HardwareAccelerationPredictionRequest,
		deadline: number,
	): Promise<HardwareAccelerationResolution> {
		if (!request.format || !request.bitDepth) {
			return this.indeterminate('The video format and bit depth are required for prediction.');
		}
		if (request.bitDepth !== 8 && request.bitDepth !== 10) {
			return this.none('Automatic acceleration supports 8-bit and 10-bit video targets.');
		}

		if (request.width === null || request.height === null) {
			return this.indeterminate(
				'Hardware support cannot be predicted when output dimensions follow the source.',
			);
		}

		const width = request.width;
		const height = request.height;
		if (width * height > MAX_PROBE_PIXELS) {
			return this.none('The video target exceeds the 8K automatic-probe limit.');
		}

		const devices = this.environment.platform === 'linux'
			? await this.environment.listVaapiDevices()
			: [];
		if (Date.now() >= deadline) {
			return this.indeterminate('Hardware support could not be determined before the probe deadline.');
		}
		const candidates = buildHardwareCandidates(
			request,
			this.environment.platform,
			this.environment.arch,
			devices,
		);
		if (candidates.length === 0) {
			return this.none('No automatic hardware backend is available on this platform.');
		}

		for (const candidate of candidates) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return this.indeterminate('Hardware support could not be determined before the probe deadline.');
			}

			const command = this.command(request, candidate, width, height);
			const result = await this.environment.runCommand(
				command,
				Math.min(CANDIDATE_TIMEOUT_MS, remaining),
			);
			if (Date.now() >= deadline) {
				return this.indeterminate('Hardware support could not be determined before the probe deadline.');
			}
			if (result === 'unavailable') {
				return this.indeterminate('The configured FFmpeg executable could not be started.');
			}
			if (result === 'supported') {
				const resolution: HardwareAccelerationResolution = {
					outcome: 'hardware',
					accel: candidate.accel,
					detail: `${candidate.label} is available for this video target.`,
					vaapiDevice: candidate.vaapiDevice,
					vaapiDriver: candidate.vaapiDriver,
				};
				this.logger.debug(
					{ accel: candidate.accel, vaapiDevice: candidate.vaapiDevice },
					'Automatic hardware acceleration resolved',
				);
				return resolution;
			}
		}

		return this.none('No compatible hardware encoder was detected for this video target.');
	}

	/** Build the target-specific one-frame FFmpeg smoke-test command. */
	private command(
		request: HardwareAccelerationPredictionRequest,
		candidate: HardwareCandidate,
		width: number,
		height: number,
	): HardwareProbeCommand {
		const pixelFormat = request.bitDepth === 10 ? 'p010le' : 'nv12';
		const filterArgs = candidate.filterArgs.map((value) => {
			if (value === 'format=nv12,hwupload') {
				return `format=${pixelFormat},hwupload`;
			}
			return value === 'TARGET_PIXEL_FORMAT' ? pixelFormat : value;
		});
		return {
			executable: request.ffmpegPath || 'ffmpeg',
			args: [
				'-hide_banner',
				'-loglevel', 'error',
				...candidate.initArgs,
				'-f', 'lavfi',
				'-i', `color=c=black:s=${width}x${height}:r=1`,
				...filterArgs,
				'-frames:v', '1',
				'-c:v', encoderName(candidate.accel, request.format),
				'-f', 'null',
				'-',
			],
			env: candidate.env,
		};
	}

	/** Construct a conclusive software fallback without backend-specific runtime values. */
	private none(detail: string): HardwareAccelerationResolution {
		return { outcome: 'none', accel: null, detail, vaapiDevice: null, vaapiDriver: null };
	}

	/** Construct an inconclusive prediction that still safely falls back at playback. */
	private indeterminate(detail: string): HardwareAccelerationResolution {
		return { outcome: 'indeterminate', accel: null, detail, vaapiDevice: null, vaapiDriver: null };
	}
}
