import { z } from 'zod';

/** Validate the audio normalization contract at runtime. */
export const audioNormalizationSchema = z.object({
	format: z.enum(['aac', 'ac3']).nullable().default('aac'),
	bitrateKbps: z.number().int().positive().nullable().default(192),
	bufferKbps: z.number().int().positive().nullable().default(384),
	channels: z.number().int().min(1).max(16).nullable().default(2),
	sampleRateHz: z.number().int().positive().nullable().default(48_000),
	normalizeLoudness: z.boolean().default(true),
	loudness: z
		.object({
			integratedTarget: z.number().nullable().default(-16),
			rangeTarget: z.number().nullable().default(11),
			truePeak: z.number().nullable().default(-1.5),
		})
		.nullable()
		.default({ integratedTarget: -16, rangeTarget: 11, truePeak: -1.5 }),
});

/** Concrete hardware backends understood by the integrated playback worker. */
export const concreteHardwareAccelerationSchema = z.enum([
	'amf',
	'cuda',
	'qsv',
	'rkmpp',
	'vaapi',
	'videotoolbox',
	'vulkan',
]);
/** Hardware-acceleration choices authored in a Moirai channel. */
export const hardwareAccelerationSchema = z.union([
	z.literal('automatic'),
	concreteHardwareAccelerationSchema,
]).nullable();
/** Concrete playback-worker hardware acceleration backend. */
export type ConcreteHardwareAcceleration = z.infer<typeof concreteHardwareAccelerationSchema>;
/** Authored channel acceleration choice, including Moirai-owned automatic selection. */
export type HardwareAcceleration = z.infer<typeof hardwareAccelerationSchema>;

/** Validate the video normalization contract at runtime. */
export const videoNormalizationSchema = z.object({
	format: z.enum(['h264', 'hevc']).nullable().default('h264'),
	bitDepth: z.number().int().min(8).max(16).nullable().default(8),
	width: z.number().int().positive().nullable().default(1920),
	height: z.number().int().positive().nullable().default(1080),
	scalingMode: z.enum(['scale_and_pad', 'stretch', 'crop']).default('scale_and_pad'),
	bitrateKbps: z.number().int().positive().nullable().default(2000),
	bufferKbps: z.number().int().positive().nullable().default(4000),
	accel: hardwareAccelerationSchema.default('automatic'),
	vaapiDevice: z.string().nullable().default(null),
	vaapiDriver: z.enum(['ihd', 'i965', 'radeonsi']).nullable().default(null),
	deinterlace: z.boolean().default(false),
});

/** Reusable audio and video settings applied together to linked channels. */
export const encodingProfileCreateSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).default(''),
	audio: audioNormalizationSchema,
	video: videoNormalizationSchema,
}).strict();
/** Named reusable encoding settings with stable identity. */
export const encodingProfileSchema = encodingProfileCreateSchema.extend({
	isBuiltin: z.boolean(),
	isDefault: z.boolean(),
	id: z.uuid(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
/** Full settings accepted for creation and replacement. */
export type EncodingProfileCreate = z.infer<typeof encodingProfileCreateSchema>;
/** Persisted reusable encoding profile. */
export type EncodingProfile = z.infer<typeof encodingProfileSchema>;

/** Stable initial default; changing the saved default never rewrites existing channels. */
export const DEFAULT_ENCODING_PROFILE_ID = '10000000-0000-4000-8000-000000001080';
/** Built-in progressive, square-pixel 16:9 presets with H.264 video and AAC stereo audio. */
export const BUILTIN_ENCODING_PROFILES = [
	{ id: '10000000-0000-4000-8000-000000000480', name: '480p', width: 854, height: 480, description: 'Lowest bandwidth, widest compatibility.', bitrateKbps: 1500 },
	{ id: '10000000-0000-4000-8000-000000000576', name: '576p', width: 1024, height: 576, description: 'Common for standard definition content.', bitrateKbps: 2000 },
	{ id: '10000000-0000-4000-8000-000000000720', name: '720p', width: 1280, height: 720, description: 'Smaller files, great for mobile devices.', bitrateKbps: 4000 },
	{ id: '10000000-0000-4000-8000-000000001080', name: '1080p', width: 1920, height: 1080, description: 'Best balance of quality and compatibility.', bitrateKbps: 8000 },
	{ id: '10000000-0000-4000-8000-000000001440', name: '1440p', width: 2560, height: 1440, description: 'Higher quality for larger screens.', bitrateKbps: 16000 },
	{ id: '10000000-0000-4000-8000-000000002160', name: '4K', width: 3840, height: 2160, description: 'Maximum quality for compatible devices.', bitrateKbps: 32000 },
].map((preset) => ({
	id: preset.id,
	...encodingProfileCreateSchema.parse({ name: preset.name, description: preset.description, audio: {}, video: { width: preset.width, height: preset.height, bitrateKbps: preset.bitrateKbps, bufferKbps: preset.bitrateKbps * 2 } }),
}));
