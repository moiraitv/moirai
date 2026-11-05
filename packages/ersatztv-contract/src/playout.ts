import type { graphicsAnchors } from '@moirai/shared';
import playoutSchema from './vendor/schema/playout.json' with { type: 'json' };
import { validateEtvDocument } from './index.js';

/** ErsatzTV playout schema URI written into every generated document. */
export const ETV_PLAYOUT_VERSION = playoutSchema.$id;

/** Concrete subtitle stream or separate source selected by the scheduler. */
export interface EtvSubtitleSelection {
	streamIndex?: number;
	path?: string;
	offsetMs?: number;
}

/** Serialize subtitle source offsets independently of the physical video part. */
function subtitleTrack(item: EtvLocalPlayoutItem): Record<string, unknown> {
	const selection = item.subtitle!;
	return {
		...(selection.streamIndex === undefined ? {} : { stream_index: selection.streamIndex }),
		...(selection.path ? { source: {
			source_type: 'local',
			path: selection.path,
			in_point_ms: (item.inPointMs ?? 0) + (selection.offsetMs ?? 0),
			...(item.outPointMs === null ? {} : { out_point_ms: item.outPointMs + (selection.offsetMs ?? 0) }),
		} } : {}),
	};
}

/** Ordered native media layer supported by the pinned engine. */
export interface EtvMediaGraphicsLayer {
	kind: 'media';
	source: { source_type: 'local'; path: string };
	location: typeof graphicsAnchors[number];
	width_percent?: number;
	horizontal_margin_percent: number;
	vertical_margin_percent: number;
	opacity_percent: number;
	within_source_content: boolean;
	timing?: {
		timing_type: 'periodic';
		clock: 'content' | 'wall';
		frequency_ms: number;
		phase_offset_ms: number;
		disable_after_ms?: number;
		fade_ms: number;
		hold_ms: number;
	};
}

/** A time-aware alpha source positioned in output pixels. */
export interface EtvCanvasGraphicsLayer {
	kind: 'canvas';
	location: 'top_left';
	layout: { mode: 'region'; origin: { x: number; y: number } };
	source: {
		source_type: 'http';
		uri: string;
		reconnect: false;
		timeout_us: number;
		probe_hint: {
			format_name: 'apng';
			video: Array<{ codec: 'apng'; width: number; height: number; pix_fmt: 'rgba'; stream_index: 0; frame_rate: '1/1' }>;
		};
	};
}

/** Ordered graphics composited by the pinned engine. */
export type EtvGraphicsLayer = EtvMediaGraphicsLayer | EtvCanvasGraphicsLayer;

/** A concrete local media item in a generated ErsatzTV playout window. */
export interface EtvLocalPlayoutItem {
	type: 'local';
	id: string;
	start: string;
	finish: string;
	path: string;
	inPointMs: number | null;
	outPointMs: number | null;
	silentAudio?: boolean;
	audioStreamIndex?: number | null;
	videoStreamIndex?: number | null;
	subtitle?: EtvSubtitleSelection | null;
	graphics?: EtvGraphicsLayer[];
}

/** A bounded black-and-silent item used for intentional dead air. */
export interface EtvDeadAirPlayoutItem {
	type: 'dead-air';
	id: string;
	start: string;
	finish: string;
	width: number;
	height: number;
}

/** Concrete item accepted by the ErsatzTV playout adapter. */
export type EtvPlayoutItem = EtvLocalPlayoutItem | EtvDeadAirPlayoutItem;

/** Represent local media offsets or bounded dead air in the pinned ErsatzTV playout format. */
function toEtvPlayoutItem(item: EtvPlayoutItem): Record<string, unknown> {
	if (item.type === 'local') {
		return {
			id: item.id,
			start: item.start,
			finish: item.finish,
			...(item.graphics?.length ? { graphics: item.graphics } : {}),
			source: {
				source_type: 'local',
				path: item.path,
				...(item.inPointMs === null ? {} : { in_point_ms: item.inPointMs }),
				...(item.outPointMs === null ? {} : { out_point_ms: item.outPointMs }),
			},
			...(item.silentAudio || item.subtitle || item.audioStreamIndex != null || item.videoStreamIndex != null
				? {
					tracks: {
						...(item.videoStreamIndex != null ? { video: { stream_index: item.videoStreamIndex } } : {}),
						...(item.subtitle ? { subtitle: subtitleTrack(item) } : {}),
						...(item.audioStreamIndex != null && !item.silentAudio ? { audio: { stream_index: item.audioStreamIndex } } : {}),
						...(item.silentAudio ? { audio: {
							source: {
								source_type: 'lavfi',
								params: 'anullsrc=channel_layout=stereo:sample_rate=48000',
							},
						} } : {}),
					},
				}
				: {}),
		};
	}

	return {
		id: item.id,
		start: item.start,
		finish: item.finish,
		tracks: {
			video: {
				source: {
					source_type: 'lavfi',
					params: `color=c=black:s=${item.width}x${item.height}:r=30`,
				},
			},
			audio: {
				source: {
					source_type: 'lavfi',
					params: 'anullsrc=channel_layout=stereo:sample_rate=48000',
				},
			},
		},
	};
}

/** Build and validate one ErsatzTV playout document. */
export function toEtvPlayout(items: EtvPlayoutItem[]): Record<string, unknown> {
	const document = {
		version: ETV_PLAYOUT_VERSION,
		items: items.map(toEtvPlayoutItem),
	};
	validateEtvDocument('playout', document);
	return document;
}
