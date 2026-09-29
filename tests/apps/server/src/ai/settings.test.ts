import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AiSettingsService } from '@server/ai/settings.js';
import { productionAiRequestOptions } from '@server/ai/provider.js';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** Create an isolated settings service with a controllable provider check. */
async function settings(fetchImpl: typeof fetch): Promise<{ service: AiSettingsService; directory: string }> {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'moirai-ai-settings-'));
	directories.push(directory);
	const service = new AiSettingsService(directory, fetchImpl);
	await service.load();
	return { service, directory };
}

/** Return the smallest valid provider completion for the connection check. */
function checked(): Response {
	return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] });
}

it('stores keys in an owner-only file and redacts them from status', async () => {
	const fetchImpl = vi.fn(async () => checked()) as unknown as typeof fetch;
	const { service, directory } = await settings(fetchImpl);
	await service.save({ activeProvider: 'openai', profile: { provider: 'openai', apiKey: 'secret-one', modelOverride: null, webSearch: false } });
	const filename = path.join(directory, 'ai-settings.json');
	expect((await stat(filename)).mode & 0o777).toBe(0o600);
	expect(await readFile(filename, 'utf8')).toContain('secret-one');
	expect(JSON.stringify(service.status())).not.toContain('secret-one');
	expect(service.status().profiles.find(profile => profile.provider === 'openai')?.keyPlaceholder).toBe('••••••');
	expect(service.active()?.model).toBe('gpt-6-sol');
	expect(fetchImpl).toHaveBeenCalledTimes(1);
	const reloaded = new AiSettingsService(directory, fetchImpl);
	await reloaded.load();
	expect(reloaded.active()?.apiKey).toBe('secret-one');
});

it('shows both ends of a long saved key and masks short keys', async () => {
	const fetchImpl = vi.fn<typeof fetch>(async url => String(url).endsWith('/messages')
		? Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] })
		: checked());
	const { service } = await settings(fetchImpl);
	await service.save({ activeProvider: 'openai', profile: { provider: 'openai', apiKey: 'sk-ab123456789tail', modelOverride: null, webSearch: false } });
	await service.save({ activeProvider: 'anthropic', profile: { provider: 'anthropic', apiKey: 'sk-ant-123456789tail', modelOverride: null, webSearch: false } });
	await service.save({ activeProvider: 'xai', profile: { provider: 'xai', apiKey: 'xai-123456789tail', modelOverride: null, webSearch: false } });
	await service.save({ activeProvider: 'openrouter', profile: { provider: 'openrouter', apiKey: 'sk-or-123456789tail', modelOverride: null, webSearch: false } });
	const placeholders = Object.fromEntries(service.status().profiles.map(profile => [profile.provider, profile.keyPlaceholder]));
	expect(placeholders).toMatchObject({ openai: 'sk-ab...tail', anthropic: 'sk-an...tail', xai: 'xai-1...tail', openrouter: 'sk-or...tail', custom: null });
	expect(JSON.stringify(service.status())).not.toContain('123456789');
	await service.forgetKey('xai');
	expect(service.status().profiles.find(profile => profile.provider === 'xai')?.keyPlaceholder).toBeNull();
});

it('remembers each provider while switching and keeps a pinned model', async () => {
	const { service } = await settings(vi.fn(async () => checked()) as unknown as typeof fetch);
	await service.save({ activeProvider: 'openai', profile: { provider: 'openai', apiKey: 'openai-key', modelOverride: 'special-model', webSearch: true, webSearchTimeLimitMinutes: 10 } });
	await service.save({ activeProvider: 'xai', profile: { provider: 'xai', apiKey: 'xai-key', modelOverride: null, webSearch: false } });
	expect(service.active()?.model).toBe('grok-4.7');
	expect(service.status().profiles.find(profile => profile.provider === 'xai')?.webSearchTimeLimitMinutes).toBe(7);
	await service.save({ activeProvider: 'openai', profile: { provider: 'openai', modelOverride: 'special-model', webSearch: true } });
	expect(service.active()).toMatchObject({ apiKey: 'openai-key', model: 'special-model', webSearchTimeLimitMinutes: 10 });
	expect(service.status().profiles.find(profile => profile.provider === 'openai')?.webSearchTimeLimitMinutes).toBe(10);
	await service.save({ activeProvider: null });
	expect(service.active()).toBeNull();
	expect(service.status().profiles.find(profile => profile.provider === 'xai')?.hasKey).toBe(true);
	await service.forgetKey('xai');
	expect(service.status().profiles.find(profile => profile.provider === 'xai')?.hasKey).toBe(false);
});

it('serializes overlapping saves and key removal without restoring forgotten credentials', async () => {
	let releaseCheck: (() => void) | undefined;
	let checkStarted: (() => void) | undefined;
	const checkGate = new Promise<void>(resolve => {
		releaseCheck = resolve;
	});
	const started = new Promise<void>(resolve => {
		checkStarted = resolve;
	});
	const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { model: string };
		if (body.model === 'grok-4.7') {
			checkStarted?.();
			await checkGate;
		}
		return String(url).endsWith('/messages')
			? Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] })
			: checked();
	}) as unknown as typeof fetch;
	const { service, directory } = await settings(fetchImpl);
	await service.save({ activeProvider: 'openai', profile: { provider: 'openai', apiKey: 'openai-key', modelOverride: null, webSearch: false } });

	const xaiSave = service.save({ activeProvider: 'xai', profile: { provider: 'xai', apiKey: 'xai-key', modelOverride: null, webSearch: false } });
	await started;
	const forget = service.forgetKey('openai');
	const anthropicSave = service.save({ activeProvider: 'anthropic', profile: { provider: 'anthropic', apiKey: 'anthropic-key', modelOverride: null, webSearch: false } });
	releaseCheck?.();
	await Promise.all([xaiSave, forget, anthropicSave]);

	const reloaded = new AiSettingsService(directory, fetchImpl);
	await reloaded.load();
	expect(reloaded.active()).toMatchObject({ providerId: 'anthropic', apiKey: 'anthropic-key' });
	expect(reloaded.status().profiles.find(profile => profile.provider === 'openai')?.hasKey).toBe(false);
	expect(reloaded.status().profiles.find(profile => profile.provider === 'xai')?.hasKey).toBe(true);
});

it('allows keyless Custom HTTP only after an explicit acknowledgement', async () => {
	const fetchImpl = vi.fn(async (_url, init) => {
		expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
		return checked();
	}) as unknown as typeof fetch;
	const { service } = await settings(fetchImpl);
	const profile = { provider: 'custom' as const, modelOverride: 'local-model', webSearch: false,
		baseUrl: 'http://127.0.0.1:11434/v1', protocol: 'chat-completions' as const };
	await expect(service.save({ activeProvider: 'custom', profile })).rejects.toThrow('plaintext HTTP');
	await service.save({ activeProvider: 'custom', profile: { ...profile, allowInsecureHttp: true } });
	expect(service.active()).toMatchObject({ apiKey: '', model: 'local-model' });
});

it.each(['openai', 'anthropic', 'xai', 'openrouter'] as const)('enables research for the %s provider', async provider => {
	const fetchImpl = vi.fn<typeof fetch>(async url => String(url).endsWith('/messages')
		? Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] })
		: checked());
	const { service } = await settings(fetchImpl);
	const status = await service.save({ activeProvider: provider, profile: {
		provider, apiKey: 'key', modelOverride: null, webSearch: true,
	} });
	expect(status.profiles.find(profile => profile.provider === provider)?.researchAvailable).toBe(true);
	expect(service.active()?.webSearch).toBe(true);
});

it('allows research for a Custom Anthropic-format endpoint when requested', async () => {
	const { service } = await settings(vi.fn<typeof fetch>(async () => Response.json({
		stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }],
	})));
	await service.save({ activeProvider: 'custom', profile: {
		provider: 'custom', modelOverride: 'local-model', webSearch: true,
		baseUrl: 'https://local.example.test/v1', protocol: 'anthropic-messages',
	} });
	expect(service.active()).toMatchObject({ protocol: 'anthropic-messages', webSearch: true });
});

it('blocks confirmed authorization failures but saves temporary failures with a warning', async () => {
	const fetchImpl = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
	const { service, directory } = await settings(fetchImpl);
	const profile = { provider: 'openrouter' as const, apiKey: 'key', modelOverride: null, webSearch: false };
	await expect(service.save({ activeProvider: 'openrouter', profile })).rejects.toThrow('rejected');
	expect(service.active()).toBeNull();
	(fetchImpl as ReturnType<typeof vi.fn>).mockImplementation(async () => Response.json({ error: { code: 401, message: 'private details' } }));
	await expect(service.save({ activeProvider: 'openrouter', profile })).rejects.toThrow('rejected');
	(fetchImpl as ReturnType<typeof vi.fn>).mockImplementation(async () => new Response('', { status: 503 }));
	const status = await service.save({ activeProvider: 'openrouter', profile });
	expect(status.connectionWarning).toContain('not verified');
	expect(service.active()?.model).toBe('deepseek/deepseek-v4-pro-0813');
	const reloaded = new AiSettingsService(directory, fetchImpl);
	await reloaded.load();
	expect(reloaded.status().connectionWarning).toContain('not verified');
});

it.each(['plain text', '{"ok":false}', '{"ok":true,"unexpected":1}'])('rejects an incompatible connection check response: %s', async content => {
	const fetchImpl = vi.fn(async () => Response.json({ choices: [
		{ finish_reason: 'stop', message: { content } },
	] })) as unknown as typeof fetch;
	const { service } = await settings(fetchImpl);

	await expect(service.save({ activeProvider: 'openai', profile: {
		provider: 'openai', apiKey: 'key', modelOverride: null, webSearch: false,
	} })).rejects.toThrow('required JSON response');
	expect(service.active()).toBeNull();
});

it.each(['non-JSON', 'empty choices', 'missing content'] as const)('rejects a malformed provider envelope: %s', async kind => {
	const fetchImpl = vi.fn<typeof fetch>(async () => kind === 'non-JSON' ? new Response('not JSON')
		: kind === 'empty choices' ? Response.json({ choices: [] })
			: Response.json({ choices: [{ finish_reason: 'stop', message: { content: null } }] }));
	const { service } = await settings(fetchImpl);

	await expect(service.save({ activeProvider: 'openai', profile: {
		provider: 'openai', apiKey: 'key', modelOverride: null, webSearch: false,
	} })).rejects.toThrow('required JSON response');
	expect(service.active()).toBeNull();
});

it('checks native and strict-schema protocols and tunes only known provider profiles', async () => {
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
		return String(url).endsWith('/messages')
			? Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] })
			: checked();
	}) as unknown as typeof fetch;
	const { service } = await settings(fetchImpl);
	await service.save({ activeProvider: 'anthropic', profile: { provider: 'anthropic', apiKey: 'key', modelOverride: null, webSearch: false } });
	expect(requests.at(-1)?.url).toBe('https://api.anthropic.com/v1/messages');
	expect(requests.at(-1)?.body).toHaveProperty('output_config.format.type', 'json_schema');
	await service.save({ activeProvider: 'anthropic', profile: { provider: 'anthropic', modelOverride: 'claude-custom', webSearch: false } });
	expect(requests.at(-1)?.url).toBe('https://api.anthropic.com/v1/messages');
	expect(service.active()?.protocol).toBe('anthropic-messages');
	await service.save({ activeProvider: 'xai', profile: { provider: 'xai', apiKey: 'key', modelOverride: null, webSearch: false } });
	expect(requests.at(-1)?.body).toHaveProperty('response_format.type', 'json_schema');
	expect(productionAiRequestOptions(service.active()!).reasoningEffort).toBe('low');
	await service.save({ activeProvider: 'openrouter', profile: { provider: 'openrouter', apiKey: 'key', modelOverride: null, webSearch: false } });
	expect(productionAiRequestOptions(service.active()!).provider).toMatchObject({ sort: 'latency', allow_fallbacks: true });
	await service.save({ activeProvider: 'openrouter', profile: { provider: 'openrouter', modelOverride: 'qwen/qwen3.5-397b-a17b', webSearch: false } });
	expect(productionAiRequestOptions(service.active()!).provider).toMatchObject({ sort: 'latency', ignore: ['Venice'] });
	await service.save({ activeProvider: 'custom', profile: { provider: 'custom', modelOverride: 'gpt-6-sol', webSearch: false,
		baseUrl: 'https://local.example.test/v1', protocol: 'chat-completions' } });
	expect(productionAiRequestOptions(service.active()!).reasoningEffort).toBeUndefined();
});
