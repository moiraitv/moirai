import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import scalarApiReference from '@scalar/fastify-api-reference';
import {
	LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE,
	liveEventSchema,
} from '@moirai/shared';
import {
	createJsonSchemaTransform,
	createJsonSchemaTransformObject,
	validatorCompiler,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { HttpRouteDependencies } from './routes/index.js';
import { registerHttpRoutes } from './routes/index.js';
import { responseSerializerCompiler } from './routes/contracts.js';

/** JSON-like object used for generated interface-description documents. */
export type ApiDescriptionDocument = Record<string, unknown>;

/** HTTP methods whose authenticated requests require the session synchronizer token. */
const csrfProtectedMethods = new Set(['delete', 'patch', 'post', 'put']);

/** Event names and operator-facing explanations included in AsyncAPI HTML. */
const liveEventDescriptions = [
	['system.ready', 'Confirms the connection and supplies its stable connection identifier.'],
	['library.changed', 'Reports library configuration, watcher, source-detection, or reconciliation changes.'],
	['scan.changed', 'Reports scan lifecycle, progress, counts, and programming impact.'],
	['channel.changed', 'Reports channel creation, updates, and deletion.'],
	['playback.changed', 'Reports playback process and playout synchronization changes.'],
	['scheduling.changed', 'Reports program, schedule-template, credit-template, and assignment changes.'],
	['timeline.changed', 'Reports durable timeline materialization health changes.'],
] as const;

/** Build inert route dependencies that must never be touched by documentation generation. */
function documentationDependencies(): HttpRouteDependencies {
	const dependency: unknown = new Proxy(() => undefined, {
		get: () => dependency,
		apply: () => {
			throw new Error('Documentation generation must not execute route dependencies');
		},
	});
	return dependency as HttpRouteDependencies;
}

/**
 * Add the CSRF header scheme and rejection response to every authenticated unsafe operation in
 * generated OpenAPI.
 */
function documentCsrfProtection(document: ApiDescriptionDocument): void {
	const paths = document.paths as Record<string, Record<string, {
		responses?: Record<string, unknown>;
		security?: Array<Record<string, unknown>>;
	}>> | undefined;
	if (!paths) {
		return;
	}

	for (const path of Object.values(paths)) {
		for (const [method, operation] of Object.entries(path)) {
			if (!csrfProtectedMethods.has(method)) {
				continue;
			}

			const cookieRequirement = operation.security?.find((requirement) =>
				Object.hasOwn(requirement, 'cookieAuth'));
			if (cookieRequirement) {
				cookieRequirement.csrfToken = [];
				if (operation.responses && operation.responses['403'] === undefined) {
					operation.responses['403'] = {
						...(operation.responses['401'] as Record<string, unknown>),
						description: 'Origin or CSRF validation failed',
					};
				}
			}
		}
	}
}

/** Generate OpenAPI from the same Fastify route registrations used in production. */
export async function createOpenApiDocument(): Promise<ApiDescriptionDocument> {
	const app = Fastify({ logger: false });
	app.setValidatorCompiler(validatorCompiler);
	app.setSerializerCompiler(responseSerializerCompiler);

	const transform = createJsonSchemaTransform({
		zodToJsonConfig: { target: 'draft-2020-12' },
	});
	const transformObject = createJsonSchemaTransformObject({
		zodToJsonConfig: { target: 'draft-2020-12' },
	});
	await app.register(swagger, {
		openapi: {
			openapi: '3.1.0',
			info: {
				title: 'Moirai HTTP API',
				description: [
					'Moirai manages media libraries, reusable scheduling rules, channel timelines,',
					'and IPTV playback through an authenticated administrator API.',
					'',
					'IPTV delivery, XMLTV, health checks, and feed artwork remain public.',
				].join('\n'),
				version: '0.1.0',
			},
			servers: [{ url: '/', description: 'Same origin as the Moirai server' }],
			components: {
				securitySchemes: {
					cookieAuth: {
						type: 'apiKey',
						in: 'cookie',
						name: 'moirai_session',
						description: 'Opaque administrator session established by local or Logto sign-in.',
					},
					csrfToken: {
						type: 'apiKey',
						in: 'header',
						name: 'X-Moirai-CSRF',
						description: [
							'Session synchronizer token returned by the authentication-session response.',
							'Required with the session cookie for authenticated POST, PUT, PATCH, and',
							'DELETE operations.',
						].join(' '),
					},
				},
			},
			tags: [
				{ name: 'Authentication', description: 'Administrator initialization and sessions.' },
				{ name: 'System', description: 'Liveness, readiness, capabilities, and live status.' },
				{ name: 'Logs', description: 'Bounded operational log browsing and downloads.' },
				{
					name: 'Playback fallback',
					description: 'Managed video used to cover otherwise unfilled playback intervals.',
				},
				{ name: 'Libraries', description: 'Media source configuration.' },
				{ name: 'Library scans', description: 'Scan lifecycle and retained history.' },
				{ name: 'Library reconciliation', description: 'Safe missing-media and source-change resolution.' },
				{ name: 'Catalog', description: 'Indexed media browsing and preview.' },
				{ name: 'Catalog artwork', description: 'Bounded browser-ready artwork variants.' },
				{ name: 'Channels', description: 'IPTV channel configuration.' },
				{ name: 'Channel logos', description: 'Managed channel logo storage.' },
				{ name: 'Programs', description: 'Reusable content eligibility and selection rules.' },
				{ name: 'Schedule templates', description: 'Reusable nominal daily schedules.' },
				{ name: 'Channel schedules', description: 'Layered template assignments.' },
				{ name: 'Schedule previews', description: 'Non-persistent duration-aware materialization.' },
				{ name: 'Scheduling', description: 'Combined scheduling configuration and health.' },
				{ name: 'Guide', description: 'Committed timeline and guide data.' },
				{ name: 'Playback', description: 'Integrated playback engine management.' },
				{ name: 'IPTV delivery', description: 'XMLTV, M3U, HLS, caption, and segment delivery.' },
			],
		},
		transform,
		transformObject,
	});
	await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
	registerHttpRoutes(app, documentationDependencies());

	try {
		await app.ready();
		const document = app.swagger() as ApiDescriptionDocument;
		documentCsrfProtection(document);
		return document;
	}
	finally {
		await app.close();
	}
}

/** Generate the formal WebSocket event contract from the shared event schema. */
export function createAsyncApiDocument(): ApiDescriptionDocument {
	const payload = z.toJSONSchema(liveEventSchema, {
		target: 'draft-2020-12',
		unrepresentable: 'any',
	});
	delete payload.$schema;

	return {
		asyncapi: '3.1.0',
		id: 'https://moirai.local/api/events',
		info: {
			title: 'Moirai Live Events',
			version: '0.1.0',
			description: [
				'Bounded server-to-client status events sent by Moirai.',
				'Browser upgrades require the configured application origin, and each connection ends',
				'with policy code 1008 when its administrator session is revoked or expires.',
				'Clients must stop reconnecting until they authenticate again after that policy close.',
				`Intentional credential replacement closes with code ${LIVE_EVENT_SESSION_REPLACED_CLOSE_CODE}`,
				'and requests a reconnect with the replacement cookie.',
				'Browser clients probe HTTP session state after abnormal closure and stop retrying when',
				'the authenticated upgrade was rejected. An inconclusive probe has a five-second',
				'deadline before transport reconnection resumes.',
				'Clients must recover authoritative state through the HTTP API after reconnecting.',
			].join(' '),
		},
		defaultContentType: 'application/json',
		servers: {
			development: {
				host: '{host}',
				pathname: '/api/v1/events',
				protocol: 'ws',
				description: 'Same-origin Moirai WebSocket endpoint on the HTTP API host.',
				security: [{ $ref: '#/components/securitySchemes/cookieAuth' }],
				variables: {
					host: { default: '127.0.0.1:3000', description: 'Moirai HTTP host and port.' },
				},
			},
		},
		channels: {
			liveEvents: {
				address: '/api/v1/events',
				description: 'Versioned live status events. The server does not accept application messages.',
				messages: {
					liveEvent: { $ref: '#/components/messages/liveEvent' },
				},
			},
		},
		operations: {
			sendLiveEvent: {
				action: 'send',
				summary: 'Send a live status event to a connected SPA client.',
				channel: { $ref: '#/channels/liveEvents' },
				messages: [{ $ref: '#/channels/liveEvents/messages/liveEvent' }],
			},
		},
		components: {
			securitySchemes: {
				cookieAuth: {
					type: 'httpApiKey',
					name: 'moirai_session',
					in: 'cookie',
					description: 'Revocable administrator session cookie governing connection lifetime.',
				},
			},
			messages: {
				liveEvent: {
					name: 'LiveEvent',
					title: 'Versioned live event',
					summary: 'One bounded change notification; REST remains authoritative.',
					contentType: 'application/json',
					payload: {
						schemaFormat: 'application/schema+json;version=draft-2020-12',
						schema: payload,
					},
				},
			},
		},
	};
}

/** Render a self-contained Scalar reference with its document and browser bundle embedded. */
export async function renderOpenApiHtml(document: ApiDescriptionDocument): Promise<string> {
	const app = Fastify({ logger: false });
	await app.register(scalarApiReference, {
		routePrefix: '/reference',
		configuration: {
			content: document,
			pageTitle: 'Moirai HTTP API',
			theme: 'saturn',
			hideClientButton: true,
		},
		logLevel: 'silent',
	});

	try {
		await app.ready();
		const response = await app.inject({ method: 'GET', url: '/reference/js/scalar.js' });
		if (response.statusCode !== 200) {
			throw new Error(`Scalar bundle rendering failed with HTTP ${response.statusCode}`);
		}

		const configuration = html(JSON.stringify({
			hideClientButton: true,
			theme: 'saturn',
		}));
		const specification = JSON.stringify(document)
			.replaceAll('&', '\\u0026')
			.replaceAll('<', '\\u003c')
			.replaceAll('>', '\\u003e');
		const browserBundle = response.body.replaceAll('</script', '<\\/script');
		return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moirai HTTP API</title>
</head>
<body>
<script id="api-reference" type="application/json" data-configuration="${configuration}">${specification}</script>
<script>${browserBundle}</script>
</body>
</html>`;
	}
	finally {
		await app.close();
	}
}

/** Escape generated text before placing it into a static HTML document. */
function html(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

/** Render the compact WebSocket reference without external scripts or styles. */
export function renderAsyncApiHtml(document: ApiDescriptionDocument): string {
	const rows = liveEventDescriptions
		.map(([name, description]) => `<tr><td><code>${html(name)}</code></td><td>${html(description)}</td></tr>`)
		.join('');
	const serialized = html(JSON.stringify(document, null, 2));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Moirai Live Events</title>
<style>
:root{color-scheme:dark;--bg:#07111b;--panel:#0c1a27;--line:#263849;--text:#ecf4f7;--muted:#aab8c4;--accent:#20d9b0}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#10263a 0,var(--bg) 48%);color:var(--text);font:16px/1.55 system-ui,sans-serif}main{max-width:1040px;margin:auto;padding:48px 24px 80px}p{color:var(--muted);max-width:760px}code{color:var(--accent)}.eyebrow{color:var(--accent);font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}h1{font-size:42px;margin:.15em 0}.panel{background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:14px;margin-top:28px;padding:24px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:12px;text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px;text-transform:uppercase}details{margin-top:28px}summary{cursor:pointer;font-weight:700}pre{background:#03080d;border:1px solid var(--line);border-radius:10px;max-height:640px;overflow:auto;padding:18px;white-space:pre-wrap}</style>
</head>
<body><main><div class="eyebrow">AsyncAPI 3.1</div><h1>Moirai Live Events</h1><p>Connect to <code>ws://&lt;host&gt;/api/v1/events</code>. Events are hints for immediate UI refresh; reload authoritative state from the HTTP API after reconnecting.</p><section class="panel"><h2>Server events</h2><table><thead><tr><th>Event type</th><th>Meaning</th></tr></thead><tbody>${rows}</tbody></table></section><details class="panel"><summary>Complete AsyncAPI contract</summary><pre>${serialized}</pre></details></main></body>
</html>`;
}

/** Render a small offline landing page linking both generated references. */
export function renderDocumentationIndex(): string {
	return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moirai API documentation</title><style>body{color-scheme:dark;background:#07111b;color:#ecf4f7;font:16px/1.5 system-ui,sans-serif;margin:0}main{max-width:760px;margin:10vh auto;padding:32px}a{display:block;color:#20d9b0;border:1px solid #263849;border-radius:12px;margin:18px 0;padding:22px;text-decoration:none}small{color:#aab8c4}</style></head><body><main><h1>Moirai API documentation</h1><p>Generated from the runtime contracts used by the server.</p><a href="openapi.html"><strong>HTTP API</strong><br><small>OpenAPI 3.1 reference</small></a><a href="asyncapi.html"><strong>Live events</strong><br><small>AsyncAPI 3.1 WebSocket reference</small></a></main></body></html>';
}
