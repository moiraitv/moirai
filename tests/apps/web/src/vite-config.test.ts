import { describe, expect, it } from 'vitest';
import {
	developmentAllowedHosts,
	developmentWebHost,
} from '../../../../apps/web/vite.config.js';

describe('Vite development network configuration', () => {
	it('keeps loopback management origins bound to their loopback interface', () => {
		expect(developmentWebHost('http://127.0.0.1:5173', undefined)).toBe('127.0.0.1');
		expect(developmentWebHost('http://[::1]:5173', undefined)).toBe('::1');
	});

	it('binds externally while allowing only the configured non-loopback hostname', () => {
		expect(developmentWebHost('http://dev.moirai.example:5173', undefined)).toBe('0.0.0.0');
		expect(developmentAllowedHosts('http://dev.moirai.example:5173')).toEqual([
			'dev.moirai.example',
		]);
	});

	it('honors an explicit bind override', () => {
		expect(developmentWebHost('http://dev.moirai.example:5173', '192.0.2.20')).toBe(
			'192.0.2.20',
		);
	});
});
