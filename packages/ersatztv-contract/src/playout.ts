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
	subtitle?: EtvSubtitleSelection | null;
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
			source: {
				source_type: 'local',
				path: item.path,
				...(item.inPointMs === null ? {} : { in_point_ms: item.inPointMs }),
				...(item.outPointMs === null ? {} : { out_point_ms: item.outPointMs }),
			},
			...(item.silentAudio || item.subtitle || item.audioStreamIndex != null
				? {
					tracks: {
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
