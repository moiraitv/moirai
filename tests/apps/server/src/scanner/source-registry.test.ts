import { describe, expect, it, vi } from 'vitest';
import type { LibrarySourceAdapter } from '@server/scanner/contracts.js';
import { UnsupportedLibrarySourceError } from '@server/scanner/contracts.js';
import { LibrarySourceRegistry } from '@server/scanner/source-registry.js';

function adapter(sourceType: string): LibrarySourceAdapter {
	return {
		sourceType,
		validateConfig: vi.fn().mockResolvedValue(undefined),
		configurationImpact: vi.fn().mockReturnValue('none'),
		discover: vi.fn(),
	};
}

describe('LibrarySourceRegistry', () => {
	it('retains registration order and delegates source validation', async () => {
		const first = adapter('first');
		const second = adapter('second');
		const registry = new LibrarySourceRegistry([first, second]);

		expect(registry.sourceTypes).toEqual(['first', 'second']);
		expect(registry.require('second')).toBe(second);
		await registry.validate('first', { endpoint: 'fixture' });
		expect(first.validateConfig).toHaveBeenCalledWith({ endpoint: 'fixture' });
		expect(registry.configurationImpact('first', { path: 'a' }, { path: 'b' })).toBe('none');
		expect(first.configurationImpact).toHaveBeenCalledWith({ path: 'a' }, { path: 'b' });
	});

	it('rejects duplicate registrations and unsupported source lookups', () => {
		expect(() => new LibrarySourceRegistry([adapter('duplicate'), adapter('duplicate')]))
			.toThrow('Duplicate library source adapter');
		expect(() => new LibrarySourceRegistry([]).require('missing'))
			.toThrow(UnsupportedLibrarySourceError);
	});
});
