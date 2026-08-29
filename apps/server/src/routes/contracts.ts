import type { FastifySchema, FastifySerializerCompiler } from 'fastify';
import { ResponseSerializationError } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { $ZodType, safeParse } from 'zod/v4/core';
import { apiErrorBodySchema } from '@moirai/shared/api-contracts';

/** HTTP status codes represented by the stable JSON error envelope. */
export type DocumentedErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 416 | 422 | 429 | 500 | 503;

/** Descriptive fields and contracts used by one generated API operation. */
interface ApiOperationContract {
	operationId: string;
	tags: string[];
	summary: string;
	description?: string;
	params?: z.ZodType;
	querystring?: z.ZodType;
	body?: z.ZodType;
	response: { [status: number]: unknown; default?: unknown };
	errors?: DocumentedErrorStatus[];
	headers?: z.ZodType;
	consumes?: string[];
	produces?: string[];
	authentication?: 'public' | 'required';
}

/** UUID path parameter shared by resource routes. */
export const idParamsSchema = z.object({ id: z.uuid() });

/** Empty response body used by successful deletion and restart operations. */
export const emptyResponseSchema = z.undefined().describe('No response body');

/** Describe one response with an explicit media type. */
export function responseContent(
	description: string,
	contentType: string,
	schema: z.ZodType,
): Record<string, unknown> {
	return {
		description,
		content: { [contentType]: { schema } },
	};
}

/** Describe one response that may use several negotiated media types. */
export function multiContentResponse(
	description: string,
	content: Record<string, z.ZodType>,
): Record<string, unknown> {
	return {
		description,
		content: Object.fromEntries(
			Object.entries(content).map(([contentType, schema]) => [contentType, { schema }]),
		),
	};
}

/** Add consistent operation metadata and safe error responses to a Fastify route schema. */
export function apiOperation(contract: ApiOperationContract): FastifySchema {
	const response = { ...contract.response };
	for (const status of contract.errors ?? []) {
		response[status] = responseContent(
			status === 500 ? 'Unexpected server failure' : 'Request could not be completed',
			'application/json',
			apiErrorBodySchema,
		);
	}
	if (contract.authentication !== 'public' && response[401] === undefined) {
		response[401] = responseContent(
			'Administrator authentication is required',
			'application/json',
			apiErrorBodySchema,
		);
	}

	return {
		operationId: contract.operationId,
		tags: contract.tags,
		summary: contract.summary,
		security: contract.authentication === 'public' ? [] : [{ cookieAuth: [] }],
		...(contract.description ? { description: contract.description } : {}),
		...(contract.params ? { params: contract.params } : {}),
		...(contract.querystring ? { querystring: contract.querystring } : {}),
		...(contract.headers ? { headers: contract.headers } : {}),
		...(contract.consumes ? { consumes: contract.consumes } : {}),
		...(contract.produces ? { produces: contract.produces } : {}),
		...(contract.body ? { body: contract.body } : {}),
		response,
	};
}

/** Binary payload marker used only to describe streamed response bodies. */
export const binaryBodySchema = z.any().describe('Binary response stream');

/** Text payload marker used for XML, playlists, captions, and logs. */
export const textBodySchema = z.string();

/** Select the Zod contract carried directly or inside Fastify's content wrapper. */
function resolvedResponseSchema(schema: unknown): $ZodType {
	if (schema instanceof $ZodType) {
		return schema;
	}

	if (
		typeof schema === 'object'
		&& schema !== null
		&& 'properties' in schema
		&& schema.properties instanceof $ZodType
	) {
		return schema.properties;
	}

	throw new TypeError('Response schema is not a Zod contract');
}

/** Validate response data forward without applying input normalizers to the public payload. */
export const responseSerializerCompiler: FastifySerializerCompiler<
	$ZodType | { properties: $ZodType }
> = ({
	schema,
	method,
	url,
}) => {
	const responseSchema = resolvedResponseSchema(schema);
	return (data) => {
		const result = safeParse(responseSchema, data);
		if (result.error) {
			throw new ResponseSerializationError(method, url, { cause: result.error });
		}

		return JSON.stringify(data);
	};
};
