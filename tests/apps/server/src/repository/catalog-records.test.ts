import { describe, expect, it } from 'vitest';
import { metadataReleaseDate } from '@server/repository/catalog-records.js';

describe('catalog record metadata', () => {
	it('returns only calendar-valid release dates without reviving rejected canonical values', () => {
		expect(metadataReleaseDate({ premiered: '2024-05-17' })).toBe('2024-05-17');
		expect(metadataReleaseDate({ premiered: '2024-05-17T14:30:00Z' })).toBe('2024-05-17');
		expect(metadataReleaseDate({ premiered: '2021-02-29' })).toBeNull();
		expect(metadataReleaseDate({ premiered: '2024-05-17invalid' })).toBeNull();
		expect(metadataReleaseDate({ premiered: '2024-05-17T25:00:00Z' })).toBeNull();
		expect(metadataReleaseDate({ releaseDate: null, premiered: '2024-05-17' })).toBeNull();
	});
});
