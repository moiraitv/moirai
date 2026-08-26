import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import SwaggerParser from '@apidevtools/swagger-parser';
import { DiagnosticSeverity, Parser } from '@asyncapi/parser';
import { stringify } from 'yaml';
import {
	createAsyncApiDocument,
	createOpenApiDocument,
	renderAsyncApiHtml,
	renderDocumentationIndex,
	renderOpenApiHtml,
	type ApiDescriptionDocument,
} from '../apps/server/src/api-documentation.js';

/** Repository root used for the ignored generated documentation directory. */
const projectRoot = path.resolve(import.meta.dirname, '..');

/** Validate one generated OpenAPI document with the independent parser. */
async function validateOpenApi(document: ApiDescriptionDocument): Promise<void> {
	await SwaggerParser.validate(document as never);
}

/** Validate one generated AsyncAPI document and report every parser error together. */
async function validateAsyncApi(document: ApiDescriptionDocument): Promise<void> {
	const result = await new Parser().parse(JSON.stringify(document));
	const errors = result.diagnostics.filter(
		(diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
	);
	if (!result.document || errors.length > 0) {
		throw new Error(
			`AsyncAPI validation failed:\n${errors.map((error) => `- ${error.message}`).join('\n')}`,
		);
	}
}

/** Build and validate both machine-readable contracts and offline HTML pages. */
async function buildDocumentation(): Promise<Record<string, string>> {
	const [openapi, asyncapi] = await Promise.all([
		createOpenApiDocument(),
		Promise.resolve(createAsyncApiDocument()),
	]);
	const openApiJson = JSON.stringify(openapi, null, 2);
	const asyncApiJson = JSON.stringify(asyncapi, null, 2);
	await Promise.all([
		validateOpenApi(JSON.parse(openApiJson) as ApiDescriptionDocument),
		validateAsyncApi(JSON.parse(asyncApiJson) as ApiDescriptionDocument),
	]);

	const openApiHtml = await renderOpenApiHtml(
		JSON.parse(openApiJson) as ApiDescriptionDocument,
	);
	return {
		'index.html': renderDocumentationIndex(),
		'openapi.json': `${openApiJson}\n`,
		'openapi.yaml': stringify(JSON.parse(openApiJson), { lineWidth: 100 }),
		'openapi.html': openApiHtml,
		'asyncapi.json': `${asyncApiJson}\n`,
		'asyncapi.yaml': stringify(JSON.parse(asyncApiJson), { lineWidth: 100 }),
		'asyncapi.html': renderAsyncApiHtml(asyncapi),
	};
}

/** Replace the ignored documentation output only after every artifact is ready. */
async function writeDocumentation(files: Record<string, string>): Promise<string> {
	const output = path.join(projectRoot, 'dist', 'api-docs');
	const temporary = await mkdtemp(path.join(tmpdir(), 'moirai-api-docs-'));
	try {
		await Promise.all(
			Object.entries(files).map(([name, content]) =>
				writeFile(path.join(temporary, name), content, 'utf8')),
		);
		await mkdir(path.dirname(output), { recursive: true });
		await rm(output, { force: true, recursive: true });
		await rename(temporary, output);
		return output;
	}
	catch (error) {
		await rm(temporary, { force: true, recursive: true });
		throw error;
	}
}

/** Run validation alone or generate the complete ignored documentation directory. */
async function main(): Promise<void> {
	const files = await buildDocumentation();
	if (process.argv.includes('--check')) {
		process.stdout.write('OpenAPI, AsyncAPI, and offline documentation are valid.\n');
		return;
	}

	const output = await writeDocumentation(files);
	process.stdout.write(`Generated API documentation in ${output}\n`);
}

await main();
