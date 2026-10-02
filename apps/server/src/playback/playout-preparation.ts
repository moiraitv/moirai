import { timeAsyncPhase, timePhase } from '../scheduling/job-timing.js';
import type { Channel, ScheduleGuide, SchedulingProgram } from '@moirai/shared';
import type { Repository } from '../repository/index.js';
import { readCommittedChannelScheduleGuide } from '../guide/schedule-guide.js';
import { prepareMediaStreams } from './audio-selection.js';
import { buildEtvPlayoutFiles, type PlayoutFallback } from './playout-output.js';
import type { PreparedSubtitles, SubtitleProgram } from './subtitle-assets.js';

/** Read-only worker requests retain full committed guides and transfer only optional asset work. */
export type PlayoutReadRequest = {
	kind: 'playout-preparation' | 'playout-documents';
	channelId: string;
	timeZone: string;
	startDate: string;
	days: number;
	fallback?: PlayoutFallback;
	subtitles?: PreparedSubtitles;
};

/** Compact main-thread work for optional subtitle assets; no primary guide transfer is required. */
export interface PlayoutPreparation {
	channel: Channel;
	guide: ScheduleGuide;
	programs: SubtitleProgram[];
}

/** Keep one coherent playout snapshot per executing worker, discarded on authoritative invalidation. */
export class PlayoutPreparationReader {
	private snapshot: { key: string; channel: Channel; guide: ScheduleGuide; programs: SchedulingProgram[] } | null = null;

	constructor(private readonly repository: Repository) {}

	/** Release stale full guides after timeline, presentation, or selection configuration changes. */
	invalidate(): void {
		this.snapshot = null;
	}

	/** Prepare optional assets or complete documents without transferring and reparsing the full guide. */
	async read(request: PlayoutReadRequest): Promise<PlayoutPreparation | Map<string, string>> {
		const key = JSON.stringify([request.channelId, request.timeZone, request.startDate, request.days]);
		if (!this.snapshot || this.snapshot.key !== key) {
			const [channel, guide, programs] = await timeAsyncPhase('read', () => Promise.all([
				this.repository.getChannel(request.channelId),
				readCommittedChannelScheduleGuide(
					this.repository,
					request.timeZone,
					request.channelId,
					request.startDate,
					request.days,
					request.days,
				),
				this.repository.listPrograms(),
			]));
			if (!channel) {
				throw new Error('Channel not found');
			}
			this.snapshot = { key, channel, guide, programs };
		}
		const { channel, guide, programs } = this.snapshot;
		if (request.kind === 'playout-documents') {
			const streams = await timeAsyncPhase('read', () => prepareMediaStreams(this.repository, channel, guide, programs));
			return timePhase('compute', () => buildEtvPlayoutFiles(
				[channel],
				guide,
				new Map([[channel.id, request.fallback!]]),
				request.subtitles,
				streams.audio,
				streams.video,
			));
		}

		// Retain only spans requiring physical subtitle or credit assets on the main thread.
		const preferences = new Map(programs.map(program => [program.id, program.config.subtitlePreferences ?? {}]));
		const compact = { ...guide, channels: guide.channels.map(entry => ({ ...entry,
			preview: { ...entry.preview, segments: entry.preview.segments.filter(segment => {
				let resolved = { ...channel.subtitlePreferences };
				for (const id of segment.programAncestry?.length ? segment.programAncestry : segment.programId ? [segment.programId] : []) {
					resolved = { ...resolved, ...preferences.get(id) };
				}
				return segment.mediaItemId && (resolved.creditsTemplateId || (resolved.policy && resolved.policy !== 'off'));
			}) }, entries: [],
		})) };
		const referenced = new Set(compact.channels.flatMap(entry => entry.preview.segments.flatMap(segment =>
			segment.programAncestry?.length ? segment.programAncestry : segment.programId ? [segment.programId] : [])));
		const assetPrograms = programs.filter(program => referenced.has(program.id)).map(program => ({
			id: program.id, config: program.config.subtitlePreferences ? { subtitlePreferences: program.config.subtitlePreferences } : {},
		}));
		return { channel, guide: compact, programs: assetPrograms };
	}
}
