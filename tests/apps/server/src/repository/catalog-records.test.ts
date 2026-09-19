import { describe, expect, it } from 'vitest';
import { inheritedGroupArtworkUrl, metadataReleaseDate } from '@server/repository/catalog-records.js';

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

describe('inherited group artwork', () => {
	it('uses a group primary artwork path as the poster role until a dedicated poster exists', () => {
		const groups = new Map([
			['show', {
				id: 'show',
				parentId: null,
				artworkRelativePath: 'Show/folder.jpg',
				posterRelativePath: null,
				landscapeRelativePath: null,
				fanartRelativePath: null,
			}],
			['season', {
				id: 'season',
				parentId: 'show',
				artworkRelativePath: null,
				posterRelativePath: null,
				landscapeRelativePath: null,
				fanartRelativePath: null,
			}],
		]);
		expect(inheritedGroupArtworkUrl('season', groups, 'poster')).toBe(
			'/api/v1/artwork/groups/show?v=Show%2Ffolder.jpg&role=poster',
		);
		expect(inheritedGroupArtworkUrl('season', groups, 'landscape')).toBeNull();
	});

	it('versions inherited group artwork from the artwork fingerprint', () => {
		const groups = new Map([
			['show', {
				id: 'show',
				parentId: null,
				artworkRelativePath: 'Show/folder.jpg',
				posterRelativePath: null,
				landscapeRelativePath: null,
				fanartRelativePath: 'Show/fanart.jpg',
				artworkVersion: 'show-fanart-v1',
			}],
		]);
		expect(inheritedGroupArtworkUrl('show', groups, 'fanart')).toBe(
			'/api/v1/artwork/groups/show?v=show-fanart-v1&role=fanart',
		);
	});
});
