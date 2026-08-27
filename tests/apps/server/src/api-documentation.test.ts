import { beforeAll, describe, expect, it } from 'vitest';
import {
	createAsyncApiDocument,
	createOpenApiDocument,
	renderAsyncApiHtml,
	renderOpenApiHtml,
	type ApiDescriptionDocument,
} from '@server/api-documentation.js';

const EXPECTED_HTTP_OPERATIONS = [
	'applyChannelMaterialization',
	'browseLibraryMedia',
	'cancelLibraryScan',
	'createChannel',
	'createLibrary',
	'createProgram',
	'createScheduleTemplate',
	'deleteChannel',
	'deleteChannelLogo',
	'deleteChannelSchedule',
	'deleteLibrary',
	'deleteProgram',
	'deleteScheduleTemplate',
	'downloadLogFile',
	'getArtwork',
	'getCapabilities',
	'getChannelLogo',
	'getChannelMasterPlaylist',
	'getChannelPlaylist',
	'getChannelSchedule',
	'getGuideSegment',
	'getHealth',
	'getLibrary',
	'getLibraryReconciliation',
	'getLiveness',
	'getMediaItem',
	'getPlaybackSessionFile',
	'getPlaybackSettings',
	'getPlaybackStatus',
	'getProgram',
	'getReadiness',
	'getScheduleGuide',
	'getScheduleTemplate',
	'getSchedulingOverview',
	'getXmltvGuide',
	'inspectMediaPreview-head',
	'listChannels',
	'listDataConflicts',
	'listLibraries',
	'listLibraryGenres',
	'listLibraryScans',
	'listLogFiles',
	'listLogs',
	'listPrograms',
	'listScheduleTemplates',
	'listTimelineMaterializations',
	'predictHardwareAcceleration',
	'previewChannelTimeline',
	'previewDraftChannelSchedule',
	'previewDraftTemplate',
	'previewMediaItem',
	'putChannelLogo',
	'reconcileLibrary',
	'resolveMediaGroupSelection',
	'resolveMediaSelection',
	'restartChannelPlayback',
	'searchMediaSourceOptions',
	'setChannelSchedule',
	'setTemplateAssignments',
	'startLibraryScan',
	'updateChannel',
	'updateLibrary',
	'updatePlaybackSettings',
	'updateProgram',
	'updateScheduleTemplate',
].sort();

const EXPECTED_EVENT_TYPES = [
	'channel.changed',
	'library.changed',
	'playback.changed',
	'scan.changed',
	'scheduling.changed',
	'system.ready',
	'timeline.changed',
].sort();

type OpenApiOperation = {
	operationId?: string;
	tags?: string[];
	summary?: string;
	responses?: Record<string, unknown>;
};

let openapi: ApiDescriptionDocument;

beforeAll(async () => {
	openapi = await createOpenApiDocument();
});

function httpOperations(document: ApiDescriptionDocument): OpenApiOperation[] {
	const methods = new Set(['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']);
	const paths = document.paths as Record<string, Record<string, OpenApiOperation>>;
	return Object.values(paths).flatMap((pathItem) =>
		Object.entries(pathItem)
			.filter(([method]) => methods.has(method))
			.map(([, operation]) => operation));
}

describe('generated interface documentation', () => {
	it('documents every registered HTTP operation with stable metadata', () => {
		expect(openapi.openapi).toBe('3.1.0');
		const operations = httpOperations(openapi);
		expect(operations.map((operation) => operation.operationId).sort())
			.toEqual(EXPECTED_HTTP_OPERATIONS);

		for (const operation of operations) {
			expect(operation.operationId).toBeTruthy();
			expect(operation.summary).toBeTruthy();
			expect(operation.tags?.length).toBeGreaterThan(0);
			expect(Object.keys(operation.responses ?? {}).length).toBeGreaterThan(0);
		}
	});

	it('documents the shared live-event union in AsyncAPI', () => {
		const asyncapi = createAsyncApiDocument();
		expect(asyncapi.asyncapi).toBe('3.1.0');

		const components = asyncapi.components as Record<string, Record<string, Record<string, unknown>>>;
		const payload = components.messages!.liveEvent!.payload as {
			schema: { oneOf: Array<{ properties: { type: { const: string } } }> };
		};
		const eventTypes = payload.schema.oneOf
			.map((variant) => variant.properties.type.const)
			.sort();
		expect(eventTypes).toEqual(EXPECTED_EVENT_TYPES);
	});

	it('renders offline HTML without external script or stylesheet dependencies', async () => {
		const [openApiHtml, asyncApiHtml] = await Promise.all([
			renderOpenApiHtml(openapi),
			Promise.resolve(renderAsyncApiHtml(createAsyncApiDocument())),
		]);

		for (const rendered of [openApiHtml, asyncApiHtml]) {
			expect(rendered).not.toMatch(/<script[^>]+src=["']https?:/i);
			expect(rendered).not.toMatch(/<link[^>]+href=["']https?:/i);
		}
		expect(openApiHtml).toContain('id="api-reference"');
		expect(openApiHtml).toContain('Moirai HTTP API');
		expect(asyncApiHtml).toContain('Moirai Live Events');
	});
});
