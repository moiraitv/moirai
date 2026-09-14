import type { FastifyInstance } from 'fastify';
import { MAX_EXPLICIT_MEDIA_GROUPS, programGroupAdditionSchema } from '@moirai/shared';
import { programGroupAdditionResultSchema } from '@moirai/shared/api-contracts';
import type { Repository } from '../repository/index.js';
import type { LiveEventHub } from '../operations/live-events.js';
import { apiOperation, idParamsSchema, responseContent } from './contracts.js';
import { parseId } from './params.js';

/** Register bounded, group-preserving additions from a library browser. */
export function registerProgramGroupRoutes(app: FastifyInstance, repository: Repository, events: LiveEventHub): void {
	app.post('/api/v1/libraries/:id/program-groups', {
		schema: apiOperation({
			operationId: 'addLibraryGroupsToProgram', tags: ['Programs'], summary: 'Add library groups to a selected-groups program',
			params: idParamsSchema, body: programGroupAdditionSchema,
			response: {
				200: responseContent('Updated selected-groups program', 'application/json', programGroupAdditionResultSchema),
				201: responseContent('Created selected-groups program', 'application/json', programGroupAdditionResultSchema),
			},
			errors: [400, 404, 409, 500, 503],
		}),
	}, async (request, reply) => {
		const libraryId = parseId(request);
		const input = programGroupAdditionSchema.parse(request.body);
		if (!(await repository.getLibrary(libraryId))) {
			throw app.httpErrors.notFound('Library not found');
		}
		if (input.destination.type === 'new') {
			const groups = await repository.listMediaGroupsByIds(libraryId, input.selection.groupIds);
			if (groups.length !== input.selection.groupIds.length) {
				throw app.httpErrors.badRequest('Every selected group must belong to this library');
			}
			const program = await repository.createProgram({
				name: input.destination.name,
				config: { type: 'content', source: { type: 'group-collection', libraryId, groupIds: input.selection.groupIds }, strategy: input.destination.strategy },
			});
			repository.invalidateSchedulingCatalog();
			events.publish({ type: 'scheduling.changed', data: { entity: 'program', change: 'created', id: program.id } });
			return reply.status(201).send({ program, created: true, addedGroupCount: groups.length, alreadySelectedCount: 0 });
		}

		const result = repository.appendProgramGroups(input.destination.programId, libraryId, input.selection.groupIds);
		if (result.status === 'not-found') {
			throw app.httpErrors.notFound('Program not found');
		}
		if (result.status === 'incompatible') {
			throw app.httpErrors.conflict('Choose a selected-groups program from this library');
		}
		if (result.status === 'invalid-groups') {
			throw app.httpErrors.badRequest('Every selected group must belong to this library');
		}
		if (result.status === 'capacity') {
			throw app.httpErrors.conflict(`The program cannot exceed ${MAX_EXPLICIT_MEDIA_GROUPS} selected groups`);
		}
		if (result.status === 'updated') {
			if (result.addedGroupCount > 0) {
				events.publish({ type: 'scheduling.changed', data: { entity: 'program', change: 'updated', id: result.program.id } });
			}
			return result;
		}
	});
}
