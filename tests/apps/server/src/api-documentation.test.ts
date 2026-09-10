import { beforeAll, describe, expect, it } from 'vitest';
import { LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE } from '@moirai/shared';
import {
	createAsyncApiDocument,
	createOpenApiDocument,
	renderAsyncApiHtml,
	renderOpenApiHtml,
	type ApiDescriptionDocument,
} from '@server/api-documentation.js';

const EXPECTED_HTTP_OPERATIONS = [
	'addLibraryItemsToProgram',
	'applyChannelMaterialization',
	'browseLibraryMedia',
	'cancelLibraryScan',
	'clearViewingPreferences',
	'completeLogtoAuthentication',
	'connectLiveEvents',
	'createChannel',
	'createCreditTemplate',
	'createEncodingProfile',
	'updateEncodingProfile',
	'deleteEncodingProfile',
	'listEncodingProfiles',
	'setDefaultEncodingProfile',
	'updateCreditTemplate',
	'deleteCreditTemplate',
	'listCreditTemplates',
	'previewCreditTemplate',
	'getChannelSubtitleIssues',
	'createLibrary',
	'createProgram',
	'createQuickChannelSetup',
	'previewQuickChannelSetup',
	'createScheduleTemplate',
	'deleteChannel',
	'deleteChannelFallbackFiller',
	'deleteChannelLogo',
	'deleteChannelSchedule',
	'deleteLibrary',
	'deleteProgram',
	'deleteGlobalFallbackFiller',
	'deleteScheduleTemplate',
	'downloadLogFile',
	'getAuthenticationSession',
	'getArtwork',
	'getCapabilities',
	'getChannelLogo',
	'getChannelFallbackFiller',
	'getChannelMasterPlaylist',
	'getChannelPlaylist',
	'getChannelSchedule',
	'getGuideSegment',
	'getGlobalFallbackFiller',
	'getHealth',
	'getLibrary',
	'getLibraryReconciliation',
	'getLiveness',
	'getMediaCardPreview',
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
	'inspectBundledFallbackFiller-head',
	'inspectChannelFallbackFiller-head',
	'inspectGlobalFallbackFiller-head',
	'listChannels',
	'listDataConflicts',
	'listLibraries',
	'listLibraryContentPreviews',
	'listLibraryGenres',
	'listLibraryScans',
	'listLogFiles',
	'listLogs',
	'listPrograms',
	'listScheduleTemplates',
	'listTimelineMaterializations',
	'listViewingPreferences',
	'loginLocalAuthentication',
	'logoutAuthenticationSession',
	'predictHardwareAcceleration',
	'previewChannelTimeline',
	'previewDraftChannelSchedule',
	'previewDraftTemplate',
	'previewChannelFallbackFiller',
	'previewBundledFallbackFiller',
	'previewGlobalFallbackFiller',
	'previewMediaItem',
	'previewQuickChannelQuery',
	'putChannelLogo',
	'putChannelFallbackFiller',
	'putGlobalFallbackFiller',
	'receiveLogtoBackchannelLogout',
	'recoverLocalAuthentication',
	'reconcileLibrary',
	'resolveMediaGroupSelection',
	'resolveMediaSelection',
	'restartChannelPlayback',
	'searchMediaSourceOptions',
	'setChannelSchedule',
	'setTemplateAssignments',
	'setupLocalAuthentication',
	'startLogtoAuthentication',
	'startLibraryScan',
	'updateChannel',
	'updateLibrary',
	'updatePlaybackSettings',
	'updateProgram',
	'updateScheduleTemplate',
	'saveLocalAuthenticationCredentials',
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
	requestBody?: {
		content?: Record<string, { schema?: Record<string, unknown> }>;
	};
	responses?: Record<string, unknown>;
	security?: Array<Record<string, unknown>>;
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

function httpOperation(document: ApiDescriptionDocument, operationId: string): OpenApiOperation {
	const operation = httpOperations(document)
		.find((candidate) => candidate.operationId === operationId);
	if (!operation) {
		throw new Error(`Missing generated operation ${operationId}`);
	}

	return operation;
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

	it('documents synchronizer-token authentication for protected unsafe operations', () => {
		const components = openapi.components as {
			securitySchemes: Record<string, Record<string, unknown>>;
		};
		expect(components.securitySchemes.csrfToken).toMatchObject({
			type: 'apiKey',
			in: 'header',
			name: 'X-Moirai-CSRF',
		});
		expect(httpOperation(openapi, 'updateChannel').security)
			.toEqual([{ cookieAuth: [], csrfToken: [] }]);
		expect(httpOperation(openapi, 'listChannels').security)
			.toEqual([{ cookieAuth: [] }]);
		expect(httpOperation(openapi, 'loginLocalAuthentication').security).toEqual([]);
		expect(httpOperation(openapi, 'connectLiveEvents').responses).toHaveProperty('403');
	});

	it('documents centrally enforced authentication failures', () => {
		const unsafeMethods = new Set(['delete', 'patch', 'post', 'put']);
		const paths = openapi.paths as Record<string, Record<string, OpenApiOperation>>;
		for (const path of Object.values(paths)) {
			for (const [method, operation] of Object.entries(path)) {
				const protectedOperation = operation.security?.some((requirement) =>
					Object.hasOwn(requirement, 'cookieAuth'));
				if (!protectedOperation) {
					continue;
				}

				expect(operation.responses).toHaveProperty('401');
				if (unsafeMethods.has(method)) {
					expect(operation.responses).toHaveProperty('403');
				}
			}
		}
	});

	it('documents fallback uploads as a multipart binary file', () => {
		for (const operationId of ['putGlobalFallbackFiller', 'putChannelFallbackFiller']) {
			const schema = httpOperation(openapi, operationId).requestBody
				?.content?.['multipart/form-data']?.schema as {
					properties?: { file?: Record<string, unknown> };
					required?: string[];
				} | undefined;
			expect(schema?.properties?.file).toMatchObject({ type: 'string', format: 'binary' });
			expect(schema?.required).toContain('file');
		}
	});

	it('documents the shared live-event union in AsyncAPI', () => {
		const asyncapi = createAsyncApiDocument();
		expect(asyncapi.asyncapi).toBe('3.1.0');
		expect((asyncapi.info as { description: string }).description).toContain('policy code 1008');
		expect((asyncapi.info as { description: string }).description)
			.toContain(`code ${LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE}`);

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
