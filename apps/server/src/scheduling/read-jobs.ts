import { timePhase, recordJobPhase } from './job-timing.js';
import { Temporal } from '@js-temporal/polyfill';
import {
	catalogProgramItemFilterSchema, type QuickChannelQueryPreviewRequest, type TimelineDraftPreview,
	type SchedulingProgram, type ProgramConfig,
} from '@moirai/shared';
import { schedulingOverviewSchema, quickChannelQueryPreviewResultSchema, timelinePreviewSchema,
	schedulingProgramStatusSchema } from '@moirai/shared/api-contracts';
import type { Repository } from '../repository/index.js';
import { currentTimestamp } from '../time.js';
import { schedulingRootProgramIds } from './catalog.js';
import { schedulingProgramStatuses, schedulingContentMatches } from './status.js';
import { compareLibraryQueryMedia } from './content-query.js';
import { libraryTypeMediaKind } from './quick-setup-resources.js';
import { generateTimelineDetailed } from './engine.js';
import { validateTemplate } from './validation.js';
import { guideTimelinePreview } from '../guide/preview.js';
import { semanticSource } from '../semantic/source.js';
import { similarityProgramStatus } from '../semantic/status.js';
import { refinementTexts } from '../semantic/refinement.js';

/** Read jobs keep catalog data on their executing thread and return only public results. */
export type SchedulingReadRequest
	= | { kind: 'overview' }
		| { kind: 'query'; input: QuickChannelQueryPreviewRequest }
		| { kind: 'persisted'; id: string; input: { startDate?: string | undefined; days: number }; timeZone: string }
		| { kind: 'template'; input: TimelineDraftPreview; timeZone: string }
		| { kind: 'similarity'; config: Extract<ProgramConfig, { type: 'similarity' | 'theme' }>; retry?: boolean };

/** Validated JSON with optional compact semantic preparation commands for the owning writer. */
export interface SchedulingReadResult {
	body: string;
	preferences?: string[];
	retryItemIds?: string[];
}

/** Synthetic resource identities are never written or reserved by preview jobs. */
const QUICK_QUERY_PREVIEW_PROGRAM_ID = '00000000-0000-4000-8000-000000000001';
/** Stable consumer identity for template drafts without a channel. */
const DRAFT_PREVIEW_CHANNEL_ID = '00000000-0000-4000-8000-000000000001';
/** Retain safe route-authored client errors across worker transport. */
const app = { httpErrors: { notFound: (message: string) => Object.assign(new Error(message), { statusCode: 404, expose: true }), badRequest: (message: string) => Object.assign(new Error(message), { statusCode: 400, expose: true }) } };

/** Load, compute, validate, and serialize a scheduling read without transferring its catalog. */
export async function schedulingRead(repository: Repository, request: SchedulingReadRequest, readComplete = (): void => {}): Promise<SchedulingReadResult> {
	const started = performance.now();
	const completeRead = (): void => {
		recordJobPhase('read', performance.now() - started);
		readComplete();
	};
	if (request.kind === 'overview') {
		const value = await overview(repository, completeRead);

		return { body: serialize(value, schedulingOverviewSchema) };
	}
	if (request.kind === 'query') {
		const value = await queryPreview(repository, request.input, completeRead);

		return { body: serialize(value, quickChannelQueryPreviewResultSchema) };
	}
	if (request.kind === 'similarity') {
		const programs = await repository.listPrograms();
		const draft: SchedulingProgram = { id: '00000000-0000-4000-8000-000000000002', name: 'Sample matches',
			config: request.config, createdAt: currentTimestamp(), updatedAt: currentTimestamp() };
		const catalog = await repository.getSchedulingCatalog([...programs, draft], [draft.id]);
		completeRead();
		const source = semanticSource(request.config, programs, catalog);
		if (!source.valid) {
			throw app.httpErrors.badRequest(source.missing);
		}
		const value = timePhase('compute', () => similarityProgramStatus(draft, programs, catalog));

		return { body: serialize(value, schedulingProgramStatusSchema), preferences: refinementTexts(request.config)
			.filter(text => request.retry || catalog.semantic?.preferences?.[text]?.status === 'pending'),
		...(request.retry ? { retryItemIds: [...source.sourceIds, ...source.items.map(media => media.id)] } : {}) };
	}
	const value = request.kind === 'persisted' ? await persisted(repository, request, completeRead) : await templateDraft(repository, request, completeRead);

	return { body: serialize(value, timelinePreviewSchema) };
}

/** Validate and encode large payloads before returning bytes to the HTTP thread. */
function serialize(value: unknown, schema: { parse: (value: unknown) => unknown }): string {
	return timePhase('serialize', () => {
		schema.parse(value);
		return JSON.stringify(value);
	});
}

/** Load the scheduling dashboard and bounded program samples together. */
async function overview(repository: Repository, readComplete: () => void) {
	const programsPromise = repository.listPrograms();
	const [programs, templates, channelSchedules, catalog] = await Promise.all([
		programsPromise,
		repository.listScheduleTemplates(),
		repository.listChannelSchedules(),
		programsPromise.then((programs) => repository.getSchedulingCatalog(programs)),
	]);
	readComplete();
	return {
		programs,
		templates,
		channelSchedules,
		programStatuses: timePhase('compute', () => schedulingProgramStatuses(programs, catalog)),
	};
}

/** Filter and order one catalog before selecting the requested result page. */
async function queryPreview(repository: Repository, input: QuickChannelQueryPreviewRequest, readComplete: () => void) {
	const library = await repository.getLibrary(input.libraryId);
	if (!library) {
		throw app.httpErrors.notFound('Library not found');
	}
	if (library.typeKey !== input.scenario) {
		throw app.httpErrors.badRequest('The library is not compatible with this scenario');
	}

	const timestamp = currentTimestamp();
	const query = catalogProgramItemFilterSchema.parse(input);
	const programConfig: Extract<SchedulingProgram['config'], { type: 'content' }> = {
		type: 'content',
		source: {
			type: 'library-query',
			...query,
			libraryId: input.libraryId,
			kinds: [libraryTypeMediaKind(input.scenario)],
			sort: input.sort,
			itemLimit: input.itemLimit,
		},
		strategy: { type: 'sequential' },
	};
	const program: SchedulingProgram = {
		id: QUICK_QUERY_PREVIEW_PROGRAM_ID,
		name: 'Quick Setup query preview',
		config: programConfig,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
	const catalog = await repository.getSchedulingCatalog([program]);
	readComplete();
	const orderedMatches = schedulingContentMatches(programConfig, catalog)
		.sort((left, right) => compareLibraryQueryMedia(left, right, input.sort));
	const matches = input.itemLimit === null
		? orderedMatches
		: orderedMatches.slice(0, input.itemLimit);
	const offset = input.cursor === null ? 0 : Number.parseInt(input.cursor, 10);
	if (!Number.isSafeInteger(offset) || offset > matches.length) {
		throw app.httpErrors.badRequest('The query cursor is invalid');
	}

	const end = Math.min(matches.length, offset + input.limit);
	return {
		indexedItemCount: matches.length,
		items: matches.slice(offset, end).map((media) => ({
			id: media.id,
			libraryId: media.libraryId,
			title: media.title,
			year: media.year,
			artworkUrl: media.artworkUrl,
			availability: media.availability,
		})),
		nextCursor: end < matches.length ? String(end) : null,
	};
}

/** Resolve an existing channel without advancing its persistent cursor. */
async function persisted(repository: Repository, request: Extract<SchedulingReadRequest, { kind: 'persisted' }>, readComplete: () => void) {
	const id = request.id;
	if (!(await repository.getChannel(id))) {
		throw app.httpErrors.notFound('Channel not found');
	}

	const query = request.input;
	const schedule = await repository.getChannelSchedule(id);
	if (!schedule) {
		throw app.httpErrors.notFound('Channel schedule not found');
	}

	const programsPromise = repository.listPrograms();
	const [templates, programs, state] = await Promise.all([
		repository.listScheduleTemplates(),
		programsPromise,
		repository.getSelectionState(id),
	]);
	const catalog = await repository.getSchedulingCatalog(
		programs,
		schedulingRootProgramIds(templates, [schedule]),
	);
	const template = templates.find((candidate) => candidate.id === schedule.defaultTemplateId);
	if (!template) {
		throw app.httpErrors.notFound('Schedule template not found');
	}

	readComplete();
	const generated = timePhase('compute', () => generateTimelineDetailed({
		channelId: id,
		timeZone: request.timeZone,
		startDate: query.startDate ?? Temporal.Now.plainDateISO(request.timeZone).toString(),
		days: query.days,
		schedule,
		template,
		templates,
		programs,
		catalog,
		state,
	}));
	return guideTimelinePreview(generated, templates, programs);
}

/** Apply the authored template to the same schedule context used by the editor. */
async function templateDraft(repository: Repository, request: Extract<SchedulingReadRequest, { kind: 'template' }>, readComplete: () => void) {
	const input = request.input;
	if (input.channelId && !(await repository.getChannel(input.channelId))) {
		throw app.httpErrors.notFound('Channel not found');
	}

	const channelId = input.channelId ?? DRAFT_PREVIEW_CHANNEL_ID;
	const programsPromise = repository.listPrograms();
	const [programs, templates] = await Promise.all([
		programsPromise,
		repository.listScheduleTemplates(),
	]);
	const [state, currentSchedule] = input.channelId
		? await Promise.all([
			repository.getSelectionState(input.channelId),
			repository.getChannelSchedule(input.channelId),
		])
		: [[], null];
	validateTemplate(input.template, programs);
	const timestamp = currentTimestamp();
	const draftTemplate = { ...input.template, createdAt: timestamp, updatedAt: timestamp };
	const draftIsAssigned = Boolean(
		currentSchedule
		&& (currentSchedule.defaultTemplateId === input.template.id
			|| currentSchedule.layers.some((layer) => layer.templateId === input.template.id)),
	);
	const previewSchedule
		= draftIsAssigned && currentSchedule
			? currentSchedule
			: {
				channelId,
				defaultTemplateId: input.template.id,
				layers: [],
				defaultFiller: currentSchedule?.defaultFiller ?? null,
				createdAt: currentSchedule?.createdAt ?? timestamp,
				updatedAt: timestamp,
			};
	const previewTemplates = templates.some((template) => template.id === input.template.id)
		? templates.map((template) =>
			template.id === input.template.id
				? { ...draftTemplate, createdAt: template.createdAt }
				: template)
		: [...templates, draftTemplate];
	const baseTemplate = previewTemplates.find(
		(template) => template.id === previewSchedule.defaultTemplateId,
	);
	if (!baseTemplate) {
		throw app.httpErrors.notFound('Base schedule template not found');
	}

	const catalog = await repository.getSchedulingCatalog(
		programs,
		schedulingRootProgramIds(previewTemplates, [previewSchedule]),
	);
	readComplete();
	const generated = timePhase('compute', () => generateTimelineDetailed({
		channelId,
		timeZone: request.timeZone,
		startDate: input.startDate ?? Temporal.Now.plainDateISO(request.timeZone).toString(),
		days: input.days,
		schedule: previewSchedule,
		template: baseTemplate,
		templates: previewTemplates,
		programs,
		catalog,
		state,
	}));
	return guideTimelinePreview(generated, previewTemplates, programs);
}
