import { aiProviderSchema, aiSettingsSaveSchema, aiSettingsStatusSchema } from '@moirai/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AiSettingsService } from '../ai/settings.js';
import { apiOperation, responseContent } from './contracts.js';

/** Settings operations never return provider secrets and are never cacheable. */
export function registerAiSettingsRoutes(app: FastifyInstance, settings: AiSettingsService): void {
	app.get('/api/v1/ai/settings', { schema: apiOperation({
		operationId: 'getAiSettings', tags: ['AI'], summary: 'Read redacted AI provider settings',
		response: { 200: responseContent('AI provider settings', 'application/json', aiSettingsStatusSchema) }, errors: [401, 500],
	}) }, async (_request, reply) => reply.header('Cache-Control', 'no-store').send(settings.status()));

	app.put('/api/v1/ai/settings', { schema: apiOperation({
		operationId: 'saveAiSettings', tags: ['AI'], summary: 'Save and activate an AI provider or disable AI',
		body: aiSettingsSaveSchema,
		response: { 200: responseContent('Updated AI provider settings', 'application/json', aiSettingsStatusSchema) },
		errors: [400, 401, 422, 500],
	}) }, async (request, reply) => reply.header('Cache-Control', 'no-store')
		.send(await settings.save(aiSettingsSaveSchema.parse(request.body))));

	app.delete('/api/v1/ai/settings/:provider/key', { schema: apiOperation({
		operationId: 'forgetAiProviderKey', tags: ['AI'], summary: 'Forget one saved AI provider key',
		params: z.object({ provider: aiProviderSchema }),
		response: { 200: responseContent('Updated AI provider settings', 'application/json', aiSettingsStatusSchema) },
		errors: [400, 401, 500],
	}) }, async (request, reply) => {
		const { provider } = z.object({ provider: aiProviderSchema }).parse(request.params);
		return reply.header('Cache-Control', 'no-store').send(await settings.forgetKey(provider));
	});
}
