import { describe, expect, it } from 'vitest';
import { parseKodiNfo } from '@server/scanner/nfo.js';
import {
	MAX_METADATA_LIST_ITEMS,
	MAX_METADATA_PEOPLE_ITEMS,
	MAX_METADATA_PLOT_LENGTH,
	MAX_METADATA_TEXT_LENGTH,
} from '@moirai/shared';

describe('parseKodiNfo', () => {
	it('normalizes common Kodi fields without depending on incidental XML layout', () => {
		const result = parseKodiNfo(`
      <?xml version="1.0" encoding="utf-8"?>
      <movie>
		<title>Moonrise</title><sorttitle>Moonrise, The</sorttitle><year>2024</year>
		<releasedate>2024-05-17</releasedate>
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
				releaseDate: '2024-05-17',
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

	it('normalizes common exact release-date aliases by source precedence', () => {
		expect(parseKodiNfo(`<movie>
			<premiered>2024-02-03</premiered>
			<releasedate>2024-03-04</releasedate>
			<aired>2024-04-05</aired>
		</movie>`).metadata.releaseDate).toBe('2024-02-03');
		expect(parseKodiNfo('<movie><aired>2021-03-04</aired></movie>').metadata.releaseDate)
			.toBe('2021-03-04');
		expect(parseKodiNfo('<movie><premiered>not-a-date</premiered></movie>').metadata.releaseDate)
			.toBeNull();
		expect(parseKodiNfo('<movie><premiered>2021-02-29</premiered></movie>').metadata.releaseDate)
			.toBeNull();
	});

	it('does not coerce absent numeric fields to zero', () => {
		expect(parseKodiNfo('<movie><title>Unknown release</title></movie>')).toMatchObject({
			year: null,
			seasonNumber: null,
			episodeNumber: null,
		});
	});

	it('accepts exporter sortorder tags while preferring Kodi order tags', () => {
		const result = parseKodiNfo(`<movie>
			<actor><name>Exporter Order</name><sortorder>2</sortorder></actor>
			<actor><name>Kodi Order</name><order>1</order><sortorder>9</sortorder></actor>
			<actor><name>Unordered</name></actor>
		</movie>`);

		expect(result.actors).toEqual([
			{ name: 'Exporter Order', role: null, sortOrder: 2 },
			{ name: 'Kodi Order', role: null, sortOrder: 1 },
			{ name: 'Unordered', role: null, sortOrder: null },
		]);
	});

	it('accepts compatible title, artwork, and provider ID aliases', () => {
		const result = parseKodiNfo(`<movie>
			<localtitle>Localized Title</localtitle>
			<name>Fallback Name</name>
			<sortname>Title, Localized</sortname>
			<imdbid>tt1234567</imdbid>
			<tmdbid>42</tmdbid>
			<tvdbid>84</tvdbid>
			<art><poster>images/poster.jpg</poster></art>
		</movie>`);

		expect(result).toMatchObject({
			title: 'Localized Title',
			sortTitle: 'Title, Localized',
			externalIds: [
				{ provider: 'imdb', value: 'tt1234567', isDefault: false },
				{ provider: 'tmdb', value: '42', isDefault: false },
				{ provider: 'tvdb', value: '84', isDefault: false },
			],
			primaryArtworkPaths: ['images/poster.jpg'],
		});
	});

	it('prefers canonical fields over compatible aliases', () => {
		const result = parseKodiNfo(`<movie>
			<title>Canonical Title</title><localtitle>Localized Title</localtitle><name>Fallback Name</name>
			<sorttitle>Canonical Sort</sorttitle><sortname>Fallback Sort</sortname>
			<thumb aspect="poster">canonical.jpg</thumb><art><poster>fallback.jpg</poster></art>
			<uniqueid type="imdb" default="true">tt1234567</uniqueid><imdbid>tt1234567</imdbid>
		</movie>`);

		expect(result).toMatchObject({
			title: 'Canonical Title',
			sortTitle: 'Canonical Sort',
			externalIds: [{ provider: 'imdb', value: 'tt1234567', isDefault: true }],
			primaryArtworkPaths: ['canonical.jpg', 'fallback.jpg'],
		});
	});

	it('imports nested community ratings and keeps the user rating distinct', () => {
		const result = parseKodiNfo(`<movie>
			<ratings>
				<rating name="tmdb"><value>6.2</value></rating>
				<rating name="imdb" default="true"><value>7.8</value></rating>
			</ratings>
			<userrating>9</userrating>
		</movie>`);

		expect(result.metadata).toMatchObject({ rating: 7.8, userRating: 9 });
	});

	it('prefers the scalar community rating over nested rating fallbacks', () => {
		const result = parseKodiNfo(`<movie>
			<rating>8.4</rating>
			<ratings><rating default="true"><value>7.8</value></rating></ratings>
		</movie>`);

		expect(result.metadata).toMatchObject({ rating: 8.4 });
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

	it('preserves extensive people credits independently of generic metadata lists', () => {
		const people = Array.from(
			{ length: 168 },
			(_, index) => `<actor><name>Actor ${index}</name></actor>`,
		).join('');
		const result = parseKodiNfo(`<movie>${people}</movie>`);

		expect(result.actors).toHaveLength(168);
		expect(result.truncatedFields).not.toContain('actors');
	});

	it('bounds people credits at their dedicated limit while retaining generic list bounds', () => {
		const people = Array.from(
			{ length: MAX_METADATA_PEOPLE_ITEMS + 1 },
			(_, index) => `<actor><name>Actor ${index}</name></actor>`,
		).join('');
		const genres = Array.from(
			{ length: MAX_METADATA_LIST_ITEMS + 1 },
			(_, index) => `<genre>Genre ${index}</genre>`,
		).join('');
		const result = parseKodiNfo(`<movie>${people}${genres}</movie>`);

		expect(result.actors).toHaveLength(MAX_METADATA_PEOPLE_ITEMS);
		expect(result.genres).toHaveLength(MAX_METADATA_LIST_ITEMS);
		expect(result.truncatedFields).toEqual(expect.arrayContaining(['actors', 'genres']));
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
