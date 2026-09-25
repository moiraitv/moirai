import { prepareSequencePreview } from './sequence-preview.js';
import type {
	ChannelScheduleDraftPreview, QuickChannelSetupCreate, SchedulingProgram, TimelinePreview, SequencePreview,
} from '@moirai/shared';
import { quickChannelSetupPreviewResultSchema, type QuickChannelSetupPreviewResult } from '@moirai/shared/api-contracts';
import { ChannelRepository } from '../repository/channels.js';
import { QuickChannelSetupRepository } from '../repository/quick-channel-setups.js';
import { SchedulingRepository } from '../repository/scheduling.js';
import type { MoiraiDatabase } from '../db/index.js';
import { currentTimestamp } from '../time.js';
import { guideTimelinePreview } from '../guide/preview.js';
import { schedulingRootProgramIds } from './catalog.js';
import { generateTimelineDetailed, type GenerateTimelineInput } from './engine.js';
import { libraryTypeMediaKind } from './quick-setup-resources.js';
import { schedulingProgramStatuses } from './status.js';
import { publicTimelineIssue } from './timeline-issues.js';

/** Small authored inputs sent to a worker without materializing the scheduling catalog. */
export type PreviewRequest = {
	kind: 'sequence';
	input: SequencePreview;
	timeZone: string;
} | {
	kind: 'channel';
	input: ChannelScheduleDraftPreview;
	timeZone: string;
} | {
	kind: 'quick';
	input: QuickChannelSetupCreate;
	timeZone: string;
	startDate: string;
	maxExplicitMediaItems: number;
};

/** Public response associated with each preview job kind. */
export interface PreviewResults {
	sequence: TimelinePreview;
	channel: TimelinePreview;
	quick: QuickChannelSetupPreviewResult;
}

/** A database-backed preview queued with the catalog revision observed by the caller. */
export interface PreviewJob {
	request: PreviewRequest;
	revision: number;
}

/** Loaded inputs and response projection, both retained on the executing thread. */
interface PreparedPreview {
	input: GenerateTimelineInput;
	project: (generated: ReturnType<typeof generateTimelineDetailed>) => PreviewResults[keyof PreviewResults];
}

/**
 * Read preview inputs without creating resources or queuing semantic inference. Own bounded catalog
 * caches independently of background generation; workers use a read-only connection and release the
 * read snapshot before generating timelines. Local execution shares this implementation.
 */
export class PreviewExecutor {
	private readonly scheduling: SchedulingRepository;
	private readonly channels: ChannelRepository;
	private readonly quick: QuickChannelSetupRepository;
	private revision: number | null = null;

	constructor(private readonly db: MoiraiDatabase) {
		this.scheduling = new SchedulingRepository(db, true);
		this.channels = new ChannelRepository(db);
		this.quick = new QuickChannelSetupRepository(db);
	}

	/** Prepare one coherent read snapshot, then generate and project outside its transaction. */
	async run(job: PreviewJob): Promise<PreviewResults[keyof PreviewResults]> {
		if (this.revision !== job.revision) {
			this.scheduling.invalidateSchedulingCatalog();
			this.revision = job.revision;
		}

		// Only the worker-owned connection may hold a transaction across awaited repository reads.
		const snapshot = this.db.$client.readonly;
		if (snapshot) {
			this.db.$client.exec('BEGIN');
		}
		let prepared: PreparedPreview;
		try {
			prepared = job.request.kind === 'channel'
				? await this.channel(job.request)
				: job.request.kind === 'sequence' ? await this.sequence(job.request) : await this.quickSetup(job.request);
		}
		finally {
			if (snapshot) {
				this.db.$client.exec('ROLLBACK');
			}
		}

		return prepared.project(generateTimelineDetailed(prepared.input));
	}

	/** Generate a standalone Sequence without reading or advancing channel playback state. */
	private async sequence(request: Extract<PreviewRequest, { kind: 'sequence' }>): Promise<PreparedPreview> {
		const input = await prepareSequencePreview(this.scheduling, request.input, request.timeZone);
		return { input, project: generated => ({ ...generated, issues: generated.issues.map(publicTimelineIssue) }) };
	}

	/** Load saved programs and selection state for an unsaved layered schedule. */
	private async channel(request: Extract<PreviewRequest, { kind: 'channel' }>): Promise<PreparedPreview> {
		const { input, timeZone } = request;
		if (!(await this.channels.getChannel(input.channelId))) {
			throw Object.assign(new Error('Channel not found'), { statusCode: 404, expose: true });
		}

		const [templates, programs, state] = await Promise.all([
			this.scheduling.listScheduleTemplates(),
			this.scheduling.listPrograms(),
			this.scheduling.getSelectionState(input.channelId),
		]);
		const template = templates.find((candidate) => candidate.id === input.schedule.defaultTemplateId);
		if (!template) {
			throw Object.assign(new Error('Base schedule template not found'), { statusCode: 404, expose: true });
		}

		const timestamp = currentTimestamp();
		const schedule = { ...input.schedule, channelId: input.channelId, createdAt: timestamp, updatedAt: timestamp };
		const catalog = await this.scheduling.getSchedulingCatalog(programs, schedulingRootProgramIds(templates, [schedule]));
		return {
			input: { channelId: input.channelId, timeZone, startDate: input.startDate, days: input.days,
				schedule, template, templates, programs, catalog, state },
			project: (generated) => guideTimelinePreview(generated, templates, programs),
		};
	}

	/** Prepare illustrative resources and one shared library catalog without saving a draft. */
	private async quickSetup(request: Extract<PreviewRequest, { kind: 'quick' }>): Promise<PreparedPreview> {
		const { input, timeZone, startDate, maxExplicitMediaItems } = request;
		const { program, template, schedule, channel } = this.quick.preview(input, maxExplicitMediaItems);
		const libraryProgram: SchedulingProgram = {
			...program,
			id: '00000000-0000-4000-8000-000000000006',
			config: {
				type: 'content',
				source: { type: 'library-query', libraryId: input.libraryId, kinds: [libraryTypeMediaKind(input.scenario)], genres: [] },
				strategy: { type: 'sequential' },
			},
		};
		const catalog = await this.scheduling.getSchedulingCatalog([program, libraryProgram]);
		return {
			input: { channelId: channel.id, timeZone, startDate, days: 1,
				schedule, template, templates: [template], programs: [program], catalog, state: [] },
			project: (generated) => {
				const [library, programming] = schedulingProgramStatuses([libraryProgram, program], catalog);
				return quickChannelSetupPreviewResultSchema.parse({
					library: { items: library!.previewItems, indexedItemCount: library!.indexedItemCount },
					programming: { items: programming!.previewItems, indexedItemCount: programming!.indexedItemCount },
					templateName: template.name,
					schedule: { ...generated, issues: generated.issues.map(publicTimelineIssue) },
				});
			},
		};
	}
}
