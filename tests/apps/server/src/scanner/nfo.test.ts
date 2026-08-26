import { describe, expect, it } from 'vitest';
import { parseKodiNfo } from '@server/scanner/nfo.js';
import { MAX_METADATA_PLOT_LENGTH, MAX_METADATA_TEXT_LENGTH } from '@moirai/shared';

describe('parseKodiNfo', () => {
	it('normalizes common Kodi fields without depending on incidental XML layout', () => {
		const result = parseKodiNfo(`
      <?xml version="1.0" encoding="utf-8"?>
      <movie>
        <title>Moonrise</title><sorttitle>Moonrise, The</sorttitle><year>2024</year>
        <plot>A test transmission.</plot><runtime>12.5</runtime>
        <genre>Drama</genre><genre>Science Fiction</genre>
        <director>Jane Director</director>
        <credits>First Writer</credits><writer>Second Writer</writer>
        <studio>Example Studio</studio><country>United States</country>
        <mpaa>PG-13</mpaa><rating>7.2</rating>
        <fileinfo><streamdetails><video><width>1920</width><height>1080</height></video></streamdetails></fileinfo>
        <actor><name>Ada Actor</name><role>Navigator</role><order>2</order></actor>
        <uniqueid type="tmdb" default="true">42</uniqueid>
      </movie>
    `);
		expect(result).toMatchObject({
			title: 'Moonrise',
			sortTitle: 'Moonrise, The',
			year: 2024,
			uniqueId: '42',
			genres: ['Drama', 'Science Fiction'],
			directors: ['Jane Director'],
			actors: [{ name: 'Ada Actor', role: 'Navigator', sortOrder: 2 }],
			metadata: {
				reportedRuntimeMinutes: 12.5,
				writers: ['First Writer', 'Second Writer'],
				studio: ['Example Studio'],
				countries: ['United States'],
				certification: 'PG-13',
				rating: 7.2,
				resolution: { width: 1920, height: 1080 },
			},
			seasonNumber: null,
			episodeNumber: null,
		});
	});

	it('does not coerce absent numeric fields to zero', () => {
		expect(parseKodiNfo('<movie><title>Unknown release</title></movie>')).toMatchObject({
			year: null,
			seasonNumber: null,
			episodeNumber: null,
		});
	});

	it('reads episode coordinates', () => {
		expect(
			parseKodiNfo(
				'<episodedetails><title>Arrival</title><season>2</season><episode>3</episode></episodedetails>',
			),
		).toMatchObject({
			title: 'Arrival',
			seasonNumber: 2,
			episodeNumber: 3,
		});
	});

	it('bounds large scalar metadata and reports the affected fields', () => {
		const result = parseKodiNfo(
			`<movie><title>${'t'.repeat(MAX_METADATA_TEXT_LENGTH + 10)}</title><plot>${'p'.repeat(MAX_METADATA_PLOT_LENGTH + 10)}</plot></movie>`,
		);
		expect(result.title).toHaveLength(MAX_METADATA_TEXT_LENGTH);
		expect(result.plot).toHaveLength(MAX_METADATA_PLOT_LENGTH);
		expect(result.truncatedFields).toEqual(expect.arrayContaining(['title', 'plot']));
	});

	it('deduplicates lists, captures provider IDs, and ignores invalid numeric fields', () => {
		const result = parseKodiNfo(`<tvshow>
			<title>Signal</title>
			<year>2024.5</year><season>-1</season><rating>12</rating>
			<studio>Studio One</studio><studio> studio one </studio>
			<tag>Space</tag><tag>SPACE</tag>
			<uniqueid type="tmdb" default="true">42</uniqueid>
			<uniqueid type="tvdb">84</uniqueid>
		</tvshow>`);
		expect(result).toMatchObject({
			year: null,
			seasonNumber: null,
			externalIds: [
				{ provider: 'tmdb', value: '42', isDefault: true },
				{ provider: 'tvdb', value: '84', isDefault: false },
			],
			metadata: { studio: ['Studio One'], tags: ['Space'], rating: null },
		});
		expect(result.invalidFields).toEqual(expect.arrayContaining(['year', 'season', 'rating']));
	});
});
