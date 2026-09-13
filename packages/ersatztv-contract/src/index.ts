import Ajv2020Module, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Channel, ConcreteHardwareAcceleration } from '@moirai/shared';
import channelSchema from './vendor/schema/channel_config.json' with { type: 'json' };
import playoutSchema from './vendor/schema/playout.json' with { type: 'json' };
import provenance from './provenance.json' with { type: 'json' };

/** Upstream ErsatzTV revision represented by the bundled compatibility snapshot. */
export const ETV_CONTRACT_REVISION = provenance.revision;

/** ErsatzTV JSON document families consumed by integrated channel workers. */
export type EtvDocumentKind = 'channel' | 'playout';

/** Runtime AJV constructor normalized across CommonJS and ESM package shapes. */
const Ajv2020 = Ajv2020Module as unknown as new (
	options: Record<string, unknown>,
) => InstanceType<(typeof import('ajv/dist/2020.js'))['default']>;
/** AJV format extension normalized across CommonJS and ESM package shapes. */
const addFormats = addFormatsModule as unknown as (
	instance: InstanceType<(typeof import('ajv'))['default']>,
) => void;
/** Validator instance configured for the pinned upstream schemas. */
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addFormat('uint8', {
	type: 'number',
	validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 255,
});
ajv.addFormat('uint16', {
	type: 'number',
	validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 65_535,
});
ajv.addFormat('uint32', {
	type: 'number',
	validate: (value: number) => Number.isInteger(value) && value >= 0 && value <= 4_294_967_295,
});

/** Compiled validators keyed by integrated worker document type. */
const validators = {
	channel: ajv.compile(channelSchema),
	playout: ajv.compile(playoutSchema),
};

/** Report generated output that fails the pinned ErsatzTV contract. */
export class EtvContractError extends Error {
	constructor(
		message: string,
		public readonly errors: ErrorObject[] = [],
	) {
		super(message);
		this.name = 'EtvContractError';
	}
}

/** Reject generated output that does not satisfy the pinned ErsatzTV schema. */
export function validateEtvDocument(kind: EtvDocumentKind, document: unknown): void {
	const validate = validators[kind];
	if (!validate(document)) {
		throw new EtvContractError(
			`Generated ${kind} document is incompatible with ErsatzTV-Next ${ETV_CONTRACT_REVISION}`,
			validate.errors ?? [],
		);
	}
}

/** Moirai channel copy whose automatic acceleration has been resolved for the pinned worker. */
export type EtvCompatibleChannel = Omit<Channel, 'video'> & {
	video: Omit<Channel['video'], 'accel'> & {
		accel: ConcreteHardwareAcceleration | null;
	};
};

/**
 * Build and validate worker settings, with viewer-visible fallback diagnostics explicitly opt-in.
 */
export function toEtvChannelConfig(
	channel: EtvCompatibleChannel,
	playoutFolder = './playout',
	showFallbackError = false,
): Record<string, unknown> {
	const document = {
		fallback: { show_error: showFallbackError },
		playout: {
			folder: playoutFolder,
			virtual_start: null,
		},
		ffmpeg: {
			ffmpeg_path: channel.ffmpegPath,
			ffprobe_path: channel.ffprobePath,
			disabled_filters: channel.disabledFilters,
			preferred_filters: channel.preferredFilters,
			reports_folder: null,
		},
		normalization: {
			audio: {
				format: channel.audio.format,
				bitrate_kbps: channel.audio.bitrateKbps,
				buffer_kbps: channel.audio.bufferKbps,
				channels: channel.audio.channels,
				sample_rate_hz: channel.audio.sampleRateHz,
				normalize_loudness: channel.audio.normalizeLoudness,
				loudness: channel.audio.loudness
					? {
						integrated_target: channel.audio.loudness.integratedTarget,
						range_target: channel.audio.loudness.rangeTarget,
						true_peak: channel.audio.loudness.truePeak,
					}
					: null,
			},
			video: {
				format: channel.video.format,
				bit_depth: channel.video.bitDepth,
				width: channel.video.width,
				height: channel.video.height,
				scaling_mode: channel.video.scalingMode,
				bitrate_kbps: channel.video.bitrateKbps,
				buffer_kbps: channel.video.bufferKbps,
				accel: channel.video.accel,
				vaapi_device: channel.video.vaapiDevice,
				vaapi_driver: channel.video.vaapiDriver,
				deinterlace: channel.video.deinterlace,
				filters: {},
			},
			subtitle: {
				mode: channel.subtitleMode,
				fonts_folder: channel.subtitleFontsFolder ?? null,
				force_style: null,
			},
		},
	};

	validateEtvDocument('channel', document);
	return document;
}

export * from './playout.js';
