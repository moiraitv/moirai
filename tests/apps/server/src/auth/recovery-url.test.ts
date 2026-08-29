import { describe, expect, it, vi } from 'vitest';
import { recoveryManagementUrl } from '@server/auth/recovery-url.js';
import { loadConfig } from '@server/config.js';

describe('authentication recovery browser URL', () => {
	it('uses an explicitly supplied management origin without probing development', async () => {
		const config = loadConfig({
			publicUrl: 'http://moirai.example.test:3000',
			managementUrl: 'http://moirai.example.test:5173',
		});
		const probe = vi.fn();

		await expect(recoveryManagementUrl(
			config,
			{ MOIRAI_MANAGEMENT_URL: 'http://moirai.example.test:5173' },
			probe,
		)).resolves.toBe('http://moirai.example.test:5173');
		expect(probe).not.toHaveBeenCalled();
	});

	it('detects the active Vite origin when development did not configure one', async () => {
		const config = loadConfig({ publicUrl: 'http://192.0.2.10:3000' });
		const probe = vi.fn().mockResolvedValue(new Response(
			'import "@vite/env"; "vite:beforeUpdate"; function createHotContext() {}',
			{ status: 200, headers: { 'content-type': 'text/javascript' } },
		));

		await expect(recoveryManagementUrl(
			config,
			{ MOIRAI_WEB_PORT: '6173' },
			probe,
		)).resolves.toBe('http://192.0.2.10:6173');
		expect(String(probe.mock.calls[0]?.[0])).toBe('http://192.0.2.10:6173/@vite/client');
	});

	it('retains the configured origin when no Vite client endpoint responds', async () => {
		const config = loadConfig({ publicUrl: 'https://moirai.example.test' });
		const probe = vi.fn().mockRejectedValue(new TypeError('unreachable'));

		await expect(recoveryManagementUrl(config, {}, probe)).resolves.toBe(
			'https://moirai.example.test',
		);
	});

	it('does not treat an unrelated development-port service as Vite', async () => {
		const config = loadConfig({ publicUrl: 'http://192.0.2.10:3000' });
		const probe = vi.fn().mockResolvedValue(new Response('<html>Another service</html>', {
			status: 200,
			headers: { 'content-type': 'text/html' },
		}));

		await expect(recoveryManagementUrl(config, {}, probe)).resolves.toBe(
			'http://192.0.2.10:3000',
		);
	});
});
