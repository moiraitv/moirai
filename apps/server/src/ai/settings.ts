import { mkdir, open, readFile, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES, aiProviderSchema, aiWebSearchTimeLimitSchema,
	type AiProvider, type AiSettingsSave, type AiSettingsStatus } from '@moirai/shared';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { parseAiJson } from './content-selection.js';
import { aiFailureCategory } from './errors.js';
import { productionAiRequestOptions, requestAiSelectionText } from './provider.js';

/** A saved provider's secret and preferences; absent overrides follow current recommendations. */
const storedProfileSchema = z.object({
	apiKey: z.string().default(''), modelOverride: z.string().nullable().default(null),
	webSearch: z.boolean().default(false), baseUrl: z.string().optional(),
	webSearchTimeLimitMinutes: aiWebSearchTimeLimitSchema.default(AI_WEB_SEARCH_DEFAULT_TIME_LIMIT_MINUTES),
	verification: z.enum(['verified', 'unverified']).default('unverified'),
	protocol: z.enum(['chat-completions', 'anthropic-messages']).optional(),
	chatJsonMode: z.enum(['json_object', 'json_schema', 'prompt_only']).optional(),
});
/** Versioned owner-only AI settings file. */
const storedSettingsSchema = z.object({
	version: z.literal(1), activeProvider: aiProviderSchema.nullable(),
	profiles: z.partialRecord(aiProviderSchema, storedProfileSchema),
});
/** Validated on-disk settings. */
type StoredSettings = z.infer<typeof storedSettingsSchema>;
/** Validated on-disk profile. */
type StoredProfile = z.infer<typeof storedProfileSchema>;

/** Maintained provider endpoints and recommended models. */
const recommendations: Record<Exclude<AiProvider, 'custom'>, { baseUrl: string; model: string }> = {
	openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-sol' },
	anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5' },
	xai: { baseUrl: 'https://api.x.ai/v1', model: 'grok-4.7' },
	openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-pro-0813' },
};
/** One verified provider configuration captured when a generation starts. */
export type AiRuntimeConfig = NonNullable<AppConfig['ai']>;

/** Show the ends of a saved key only when enough characters remain hidden. */
function keyPlaceholder(apiKey: string): string | null {
	if (!apiKey) {
		return null;
	}
	if (apiKey.length < 14) {
		return '••••••';
	}
	return `${apiKey.slice(0, 5)}...${apiKey.slice(-4)}`;
}

/** Build a safe runtime snapshot without exposing secrets to the Settings response. */
function resolveProfile(provider: AiProvider, profile: StoredProfile): AiRuntimeConfig | null {
	const recommended = provider === 'custom' ? null : recommendations[provider];
	const model = profile.modelOverride || recommended?.model;
	const baseUrl = provider === 'custom' ? profile.baseUrl : recommended?.baseUrl;
	if (!model || !baseUrl || (provider !== 'custom' && !profile.apiKey)) {
		return null;
	}
	const protocol = provider === 'anthropic' ? 'anthropic-messages' : profile.protocol;
	const chatJsonMode = protocol === 'anthropic-messages' ? undefined : provider === 'custom' ? profile.chatJsonMode
		: provider === 'xai' && model === recommendations.xai.model ? 'json_schema'
			: provider === 'openrouter' && model === recommendations.openrouter.model ? 'json_schema' : undefined;
	return {
		apiKey: profile.apiKey, model, baseUrl, providerId: provider,
		webSearch: profile.webSearch,
		webSearchTimeLimitMinutes: profile.webSearchTimeLimitMinutes,
		...(protocol ? { protocol } : {}), ...(chatJsonMode ? { chatJsonMode } : {}),
	};
}

/** Validate a custom endpoint without retaining URL credentials or query secrets. */
function validateCustomUrl(value: string | undefined, allowInsecureHttp: boolean): string {
	let url: URL;
	try {
		url = new URL(value ?? '');
	}
	catch {
		throw Object.assign(new Error('Enter a valid Custom endpoint URL.'), { statusCode: 400, expose: true });
	}
	if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
		|| (url.protocol === 'http:' && !allowInsecureHttp)) {
		throw Object.assign(new Error('Custom endpoint must use HTTPS, or acknowledge a plaintext HTTP connection, without URL credentials, query, or fragment.'), { statusCode: 400, expose: true });
	}
	return url.href.replace(/\/+$/u, '');
}

/** Own persisted AI profiles and serialize mutations while exposing snapshots for new generations. */
export class AiSettingsService {
	private state: StoredSettings = { version: 1, activeProvider: null, profiles: {} };
	private readonly filePath: string;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(dataDir: string, private readonly fetchImpl: typeof fetch = fetch) {
		this.filePath = path.join(dataDir, 'ai-settings.json');
	}

	/** Read persisted settings; malformed files fail startup instead of silently disabling AI. */
	async load(): Promise<void> {
		try {
			this.state = storedSettingsSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
			await chmod(this.filePath, 0o600);
		}
		catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw cause;
			}
		}
	}

	/** Return a redacted status for all five providers. */
	status(): AiSettingsStatus {
		return { activeProvider: this.state.activeProvider,
			connectionWarning: this.state.activeProvider
				&& this.state.profiles[this.state.activeProvider]?.verification === 'unverified'
				? 'Connection not verified. The provider was temporarily unavailable or did not complete the check.' : null,
			profiles: aiProviderSchema.options.map(provider => {
				const profile = this.state.profiles[provider] ?? storedProfileSchema.parse({});
				return { provider, hasKey: Boolean(profile.apiKey), keyPlaceholder: keyPlaceholder(profile.apiKey),
					modelOverride: profile.modelOverride,
					effectiveModel: profile.modelOverride || (provider === 'custom' ? '' : recommendations[provider].model),
					webSearch: profile.webSearch, researchAvailable: true,
					webSearchTimeLimitMinutes: profile.webSearchTimeLimitMinutes,
					...(provider === 'custom' ? { baseUrl: profile.baseUrl ?? '', protocol: profile.protocol ?? 'chat-completions',
						chatJsonMode: profile.chatJsonMode ?? 'json_object' } : {}),
				};
			}) };
	}

	/** Capture the active settings so a later Save cannot alter a running generation. */
	active(): AiRuntimeConfig | null {
		const provider = this.state.activeProvider;
		return provider ? resolveProfile(provider, this.state.profiles[provider] ?? storedProfileSchema.parse({})) : null;
	}

	/** Atomically replace the owner-only file before publishing the new in-memory state. */
	private async persist(next: StoredSettings): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		const temporary = `${this.filePath}.${randomUUID()}.tmp`;
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(JSON.stringify(next));
			await handle.sync();
			await handle.close();
			await rename(temporary, this.filePath);
			await chmod(this.filePath, 0o600);
		}
		catch (cause) {
			await handle.close().catch(() => {});
			await unlink(temporary).catch(() => {});
			throw cause;
		}
		this.state = next;
	}

	/** Keep checks and writes in request order so a later mutation cannot be overwritten. */
	private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationTail.then(operation);
		this.mutationTail = result.then(() => {}, () => {});
		return result;
	}

	/** Save one profile after a bounded no-search connection check, or disable AI. */
	async save(input: AiSettingsSave): Promise<AiSettingsStatus> {
		return this.serializeMutation(() => this.saveProfile(input));
	}

	/** Validate and persist one profile against the latest completed mutation. */
	private async saveProfile(input: AiSettingsSave): Promise<AiSettingsStatus> {
		const next = structuredClone(this.state);
		if (input.activeProvider === null) {
			next.activeProvider = null;
			await this.persist(next);
			return this.status();
		}
		if (!input.profile || input.profile.provider !== input.activeProvider) {
			throw Object.assign(new Error('Choose and save a provider profile.'), { statusCode: 400, expose: true });
		}
		const { provider, apiKey, modelOverride, webSearch, webSearchTimeLimitMinutes, allowInsecureHttp } = input.profile;
		const previous = next.profiles[provider] ?? storedProfileSchema.parse({});
		const profile: StoredProfile = { ...previous, modelOverride, webSearch,
			...(webSearchTimeLimitMinutes !== undefined ? { webSearchTimeLimitMinutes } : {}),
			...(apiKey !== undefined ? { apiKey: apiKey.trim() } : {}) };
		if (provider === 'custom') {
			profile.baseUrl = validateCustomUrl(input.profile.baseUrl, allowInsecureHttp === true);
			profile.protocol = input.profile.protocol ?? 'chat-completions';
			profile.chatJsonMode = input.profile.chatJsonMode ?? 'json_object';
			if (!profile.modelOverride) {
				throw Object.assign(new Error('Enter a Custom model ID.'), { statusCode: 400, expose: true });
			}
		}
		const resolved = resolveProfile(provider, profile);
		if (!resolved) {
			throw Object.assign(new Error('Enter an API key for this provider.'), { statusCode: 400, expose: true });
		}

		// One small request validates credentials and request format without spending on research.
		let verified = true;
		try {
			const response = await requestAiSelectionText({ ...resolved, webSearch: false }, [
				{ role: 'system', content: 'Reply with a JSON object containing only {"ok":true}.' },
				{ role: 'user', content: 'Connection check.' },
			], this.fetchImpl, { ...productionAiRequestOptions(resolved),
				signal: AbortSignal.timeout(15_000), maxCompletionTokens: 64,
				...((resolved.chatJsonMode === 'json_schema' || resolved.protocol === 'anthropic-messages')
					? { jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } },
						required: ['ok'], additionalProperties: false } } : {}),
			});
			parseAiJson(response, z.object({ ok: z.literal(true) }).strict());
		}
		catch (cause) {
			const category = aiFailureCategory(cause);
			if (category === 'invalid-selection') {
				throw Object.assign(new Error('The provider did not return the required JSON response. Check its model and JSON format settings.'), { statusCode: 422, expose: true });
			}
			if (category === 'authorization' || category === 'configuration') {
				throw Object.assign(new Error('The provider rejected the key, model, or request format. Check these settings and try again.'), { statusCode: 422, expose: true });
			}
			verified = false;
		}
		profile.verification = verified ? 'verified' : 'unverified';
		next.profiles[provider] = profile;
		next.activeProvider = provider;
		await this.persist(next);
		return this.status();
	}

	/** Forget only the named secret, disabling that active hosted provider if necessary. */
	async forgetKey(provider: AiProvider): Promise<AiSettingsStatus> {
		return this.serializeMutation(() => this.forgetSavedKey(provider));
	}

	/** Remove a secret after any earlier provider checks and writes have completed. */
	private async forgetSavedKey(provider: AiProvider): Promise<AiSettingsStatus> {
		const next = structuredClone(this.state);
		const profile = next.profiles[provider];
		if (profile) {
			profile.apiKey = '';
		}
		if (next.activeProvider === provider && provider !== 'custom') {
			next.activeProvider = null;
		}
		await this.persist(next);
		return this.status();
	}
}
