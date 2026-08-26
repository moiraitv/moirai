import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
	libraryCreateSchema,
	libraryUpdateSchema,
	reconciliationActionSchema,
	type LibraryCreate,
} from '@moirai/shared';
import {
	acceptedStatusSchema,
	libraryReconciliationSchema,
	librarySchema,
	scanHistorySchema,
} from '@moirai/shared/api-contracts';
import type { ArtworkCache } from '../artwork/artwork-cache.js';
import type { LiveEventHub } from '../operations/live-events.js';
import type { Repository } from '../repository/index.js';
import type { ScannerManager } from '../scanner/manager.js';
import type { TimelineMaterializer } from '../scheduling/timeline-materializer.js';
import {
	InvalidLibrarySourceConfigurationError,
	UnsupportedLibrarySourceError,
} from '../scanner/contracts.js';
import { parseId } from './params.js';
import { apiOperation, emptyResponseSchema, idParamsSchema, responseContent } from './contracts.js';

/** Services required to configure, scan, and reconcile libraries. */
interface LibraryRouteDependencies {
	repository: Repository;
	scanner: ScannerManager;
	events: LiveEventHub;
	artworkCache: ArtworkCache;
	timelineMaterializer: TimelineMaterializer;
}

/** Register library configuration, scan, and reconciliation endpoints. */
export function registerLibraryRoutes(
	app: FastifyInstance,
	{ repository, scanner, events, artworkCache, timelineMaterializer }: LibraryRouteDependencies,
): void {
	// Validate source definitions through their registered scanner adapter before persistence.
	const validateLibrarySource = async (
		input: Pick<LibraryCreate, 'sourceType' | 'sourceConfig'>,
	): Promise<void> => {
		try {
			await scanner.validateSource(input.sourceType, input.sourceConfig);
		}
		catch (error) {
			if (error instanceof UnsupportedLibrarySourceError) {
				throw app.httpErrors.badRequest(`Source type is not supported: ${error.sourceType}`);
			}
			if (error instanceof InvalidLibrarySourceConfigurationError) {
				throw app.httpErrors.badRequest(error.message);
			}

			throw error;
		}
	};

	// Library configuration and source changes.
	app.get('/api/v1/libraries', {
		schema: apiOperation({
			operationId: 'listLibraries',
			tags: ['Libraries'],
			summary: 'List media libraries',
			response: { 200: responseContent('Configured libraries', 'application/json', z.array(librarySchema)) },
			errors: [500, 503],
		}),
	}, async () => repository.listLibraries());
	app.post('/api/v1/libraries', {
		schema: apiOperation({
			operationId: 'createLibrary',
			tags: ['Libraries'],
			summary: 'Create a media library',
			body: libraryCreateSchema,
			response: { 201: responseContent('Created library', 'application/json', librarySchema) },
			errors: [400, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const input = libraryCreateSchema.parse(request.body);
		await validateLibrarySource(input);
		const library = await repository.createLibrary(input);
		events.publish({ type: 'library.changed', data: { libraryId: library.id, change: 'created' } });
		await scanner.refreshLibrary(library.id);
		void scanner.scan(library.id, 'initial').catch(() => undefined);
		return reply.status(201).send(library);
	});
	app.get('/api/v1/libraries/:id', {
		schema: apiOperation({
			operationId: 'getLibrary',
			tags: ['Libraries'],
			summary: 'Read a media library',
			params: idParamsSchema,
			response: { 200: responseContent('Media library', 'application/json', librarySchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const library = await repository.getLibrary(parseId(request));
		if (!library) {
			throw app.httpErrors.notFound('Library not found');
		}

		return library;
	});
	app.patch('/api/v1/libraries/:id', {
		schema: apiOperation({
			operationId: 'updateLibrary',
			tags: ['Libraries'],
			summary: 'Update a media library',
			description: 'Source-root and identity changes may require reconciliation before they become authoritative.',
			params: idParamsSchema,
			body: libraryUpdateSchema,
			response: { 200: responseContent('Updated library', 'application/json', librarySchema) },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request) => {
		const id = parseId(request);
		const existing = await repository.getLibrary(id);
		if (!existing) {
			throw app.httpErrors.notFound('Library not found');
		}

		const input = libraryUpdateSchema.parse(request.body);
		const sourceType = input.sourceType ?? existing.sourceType;
		const sourceConfig = input.sourceConfig ?? existing.sourceConfig;
		await validateLibrarySource({ sourceType, sourceConfig });
		const sourceConfigurationImpact = sourceType === existing.sourceType
			? scanner.sourceConfigurationImpact(sourceType, existing.sourceConfig, sourceConfig)
			: 'identity';
		const identityAffectingChange
			= (input.typeKey !== undefined && input.typeKey !== existing.typeKey)
				|| sourceType !== existing.sourceType
				|| sourceConfigurationImpact === 'identity';
		const indexAffectingChange
			= identityAffectingChange || sourceConfigurationImpact === 'index';
		const library = identityAffectingChange
			? await repository.stageLibrarySourceChange(id, input, existing)
			: await repository.updateLibrary(id, input, existing);
		if (!library) {
			throw app.httpErrors.notFound('Library not found');
		}

		await scanner.refreshLibrary(id);
		events.publish({ type: 'library.changed', data: { libraryId: id, change: 'updated' } });
		if (library.enabled && (indexAffectingChange || (!existing.enabled && library.enabled))) {
			void scanner.scan(id, 'manual').catch(() => undefined);
		}
		return library;
	});
	app.delete('/api/v1/libraries/:id', {
		schema: apiOperation({
			operationId: 'deleteLibrary',
			tags: ['Libraries'],
			summary: 'Delete a media library',
			params: idParamsSchema,
			response: { 204: emptyResponseSchema },
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		await scanner.stopLibrary(id);
		if (!(await repository.deleteLibrary(id))) {
			throw app.httpErrors.notFound('Library not found');
		}

		await artworkCache.purgeLibrary(id);
		events.publish({ type: 'library.changed', data: { libraryId: id, change: 'deleted' } });
		return reply.status(204).send();
	});
	// Scan lifecycle and retained scan history.
	app.post('/api/v1/libraries/:id/scans', {
		schema: apiOperation({
			operationId: 'startLibraryScan',
			tags: ['Library scans'],
			summary: 'Start a library scan',
			params: idParamsSchema,
			response: { 202: responseContent('Scan accepted', 'application/json', acceptedStatusSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.getLibrary(id))) {
			throw app.httpErrors.notFound('Library not found');
		}

		void scanner.scan(id, 'manual').catch(() => undefined);
		return reply.status(202).send({ status: 'accepted' });
	});
	app.delete('/api/v1/libraries/:id/scans/current', {
		schema: apiOperation({
			operationId: 'cancelLibraryScan',
			tags: ['Library scans'],
			summary: 'Cancel the active library scan',
			params: idParamsSchema,
			response: {
				202: responseContent('Cancellation requested', 'application/json', acceptedStatusSchema),
				204: emptyResponseSchema,
			},
			errors: [400, 404, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		if (!(await repository.getLibrary(id))) {
			throw app.httpErrors.notFound('Library not found');
		}

		if (!(await scanner.cancelScan(id))) {
			return reply.status(204).send();
		}

		return reply.status(202).send({ status: 'cancelling' });
	});
	app.get('/api/v1/libraries/:id/scans', {
		schema: apiOperation({
			operationId: 'listLibraryScans',
			tags: ['Library scans'],
			summary: 'List retained library scans',
			params: idParamsSchema,
			response: { 200: responseContent('Retained scan history', 'application/json', scanHistorySchema) },
			errors: [400, 500, 503],
		}),
	}, async (request) => repository.listScans(parseId(request)));
	// Explicit reconciliation for missing media and replacement sources.
	app.get('/api/v1/libraries/:id/reconciliation', {
		schema: apiOperation({
			operationId: 'getLibraryReconciliation',
			tags: ['Library reconciliation'],
			summary: 'Read library reconciliation state',
			params: idParamsSchema,
			response: { 200: responseContent('Reconciliation state', 'application/json', libraryReconciliationSchema) },
			errors: [400, 404, 500, 503],
		}),
	}, async (request) => {
		const reconciliation = await repository.getLibraryReconciliation(parseId(request));
		if (!reconciliation) {
			throw app.httpErrors.notFound('Library not found');
		}

		return reconciliation;
	});
	app.post('/api/v1/libraries/:id/reconciliation', {
		schema: apiOperation({
			operationId: 'reconcileLibrary',
			tags: ['Library reconciliation'],
			summary: 'Apply a library reconciliation action',
			params: idParamsSchema,
			body: reconciliationActionSchema,
			response: {
				200: responseContent('Updated reconciliation state', 'application/json', libraryReconciliationSchema),
				202: responseContent('Source acceptance queued', 'application/json', acceptedStatusSchema),
			},
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const id = parseId(request);
		const input = reconciliationActionSchema.parse(request.body);
		if (input.action === 'confirm-removals') {
			if (!(await repository.confirmLibraryRemovals(id, input.revision))) {
				throw app.httpErrors.conflict('The reconciliation changed; refresh it before confirming');
			}

			events.publish({ type: 'library.changed', data: { libraryId: id, change: 'updated' } });
			void timelineMaterializer.runNow(true).catch(() => undefined);
			return repository.getLibraryReconciliation(id);
		}

		if (input.action === 'accept-source') {
			if (!(await repository.authorizeSourceAcceptance(id, input.revision))) {
				throw app.httpErrors.conflict('The source candidate changed; refresh it before accepting');
			}

			void scanner
				.scan(id, 'manual')
				.then(() => scanner.refreshLibrary(id))
				.catch(() => undefined);
			return reply.status(202).send({ status: 'accepted' });
		}

		if (!(await repository.cancelSourceChange(id, input.revision))) {
			throw app.httpErrors.conflict('The source change cannot be cancelled in its current state');
		}

		await scanner.refreshLibrary(id);
		void scanner.scan(id, 'manual').catch(() => undefined);
		events.publish({ type: 'library.changed', data: { libraryId: id, change: 'updated' } });
		return repository.getLibraryReconciliation(id);
	});
}
