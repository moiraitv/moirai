import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MAX_METADATA_TEXT_LENGTH, libraryCreateSchema, scanIssueRequiresAttention, type ScanIssue } from '@moirai/shared';
import { createDatabase } from '@server/db/index.js';
import { Repository } from '@server/repository/index.js';
import { discoverOnDisk } from '@server/scanner/on-disk.js';
import { parseMediaProbeOutput } from '@server/media/media-probe.js';
import { libraryScanStatus } from '@web/library-health';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

async function fixture(typeKey: string, filename: string, nfo?: string, groupNfo?: string, tags: Record<string, string> = {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'moirai-quiet-metadata-'));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const database = createDatabase(':memory:', path.resolve('drizzle'));
	cleanups.push(() => database.close());
	const repository = new Repository(database.db);
	const library = await repository.createLibrary(libraryCreateSchema.parse({
		name: 'Fixture', typeKey, sourceType: 'on-disk', sourceConfig: { scanRoot: root },
	}));
	const file = path.join(root, filename);
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, 'video');
	if (nfo !== undefined) {
		await writeFile(file.replace(/\.mp4$/, '.nfo'), nfo);
	}
	if (groupNfo !== undefined) {
		await writeFile(path.join(root, filename.split('/')[0]!, 'tvshow.nfo'), groupNfo);
	}
	const probeMedia = async () => parseMediaProbeOutput(JSON.stringify({ format: { tags }, streams: [
		{ index: 0, codec_type: 'video', start_time: '0', duration: '100', width: 1920, height: 1080 },
		{ index: 1, codec_type: 'audio', start_time: '0', duration: '100' },
	] }), 5);
	const found = await discoverOnDisk(library, { probeMedia });
	const run = await repository.beginScan(library.id, 'manual');
	const completed = await repository.reconcileScan(run, found.groups, found.items, found.issues, true, found.sourceIdentity, found.conflicts);
	return { repository, library, found, completed };
}

it('retains unused tvshow season and episode diagnostics without dirtying library health', async () => {
	const { repository, library, completed, found } = await fixture(
		'shows',
		'1883/S01E01.mp4',
		'<episodedetails><title>Pilot</title></episodedetails>',
		'<tvshow><title>1883</title><season>-1</season><episode>-1</episode><disc>-1</disc><track>-1</track></tvshow>',
	);
	expect(completed.issues).toContainEqual(expect.objectContaining({
		path: '1883/tvshow.nfo', code: 'metadata_invalid', informational: true,
		message: expect.stringContaining('season, episode'),
	}));
	expect(found.items[0]).toMatchObject({ seasonNumber: 1, episodeNumber: 1, metadataStatus: 'complete' });
	expect(completed.issues.filter(scanIssueRequiresAttention)).toEqual([]);
	const current = (await repository.getLibrary(library.id))!;
	expect(current.warningCount).toBe(0);
	expect(libraryScanStatus(current)).toBe('Idle');
	expect((await repository.listScans(library.id))[0]!.issues).toEqual(completed.issues);
});

it.each([
	['shows', 'Show/S01E02.mp4', true],
	['shows', 'Show/Pilot.mp4', false],
	['movies', 'Film.mp4', true],
])('classifies invalid numbering for %s %s using resolved identity', async (typeKey, filename, quiet) => {
	const { completed } = await fixture(typeKey, filename, '<episodedetails><season>-1</season><episode>-1</episode></episodedetails>');
	const issue = completed.issues.find(issue => issue.code === 'metadata_invalid')!;
	expect(Boolean(issue.informational)).toBe(quiet);
	expect(scanIssueRequiresAttention(issue)).toBe(!quiet);
});

it.each([
	['movies', 'Film (2020).mp4', true],
	['shows', 'Show/S01E02.mp4', true],
	['shows', 'Show/Pilot.mp4', false],
])('keeps missing NFO detection and completeness for %s %s', async (typeKey, filename, quiet) => {
	const { completed, found } = await fixture(typeKey, filename);
	const issue = completed.issues.find(issue => issue.code === 'nfo_missing')!;
	expect(Boolean(issue.informational)).toBe(quiet);
	expect(found.items[0]!.metadataStatus).toBe('incomplete');
});

it('separates harmless fields from an actionable rating and preserves ignore/restore counts', async () => {
	const { repository, library, completed } = await fixture(
		'movies',
		'Film (2020).mp4',
		'<movie><year>-1</year><runtime>-1</runtime><rating>99</rating><fileinfo><streamdetails><video><width>-1</width><height>-1</height></video></streamdetails></fileinfo></movie>',
	);
	const metadata = completed.issues.filter(issue => issue.code === 'metadata_invalid');
	expect(metadata).toHaveLength(2);
	const active = metadata.find(scanIssueRequiresAttention)!;
	const quiet = metadata.find(issue => issue.informational)!;
	expect(active.message).toContain('rating');
	expect(quiet.message).toContain('runtime');
	expect(quiet.message).toContain('year');
	expect(quiet.message).toContain('width, height');
	expect((await repository.getLibrary(library.id))!.warningCount).toBe(1);
	for (const ignored of [true, false]) {
		expect(repository.setMediaIssueIgnored(library.id, active.path!, active.code, active.ignoreState!.fingerprint, ignored)).toBe(true);
		expect((await repository.getLibrary(library.id))!.warningCount).toBe(ignored ? 0 : 1);
	}
});

it('retains bounded presentation diagnostics but warns about truncated stable identity', async () => {
	const text = 'x'.repeat(MAX_METADATA_TEXT_LENGTH + 1);
	const { completed, found } = await fixture('movies', 'Film.mp4', `<movie><title>${text}</title><uniqueid>${text}</uniqueid></movie>`);
	const issues = completed.issues.filter(issue => issue.code === 'metadata_truncated');
	expect(issues).toHaveLength(2);
	expect(issues.find(issue => issue.informational)!.message).toContain('title');
	expect(issues.find(scanIssueRequiresAttention)!.message).toContain('uniqueId');
	expect(found.items[0]!.title).toHaveLength(MAX_METADATA_TEXT_LENGTH);
});

it('does not make malformed metadata informational', async () => {
	const { completed } = await fixture('movies', 'Film.mp4', 'not an NFO');
	expect(completed.issues).toContainEqual(expect.objectContaining({ code: 'nfo_invalid' }));
	expect(completed.issues.filter(scanIssueRequiresAttention)).toHaveLength(1);
});

it('cannot restore a purely informational diagnostic into library warnings', async () => {
	const { repository, library, completed } = await fixture('movies', 'Film.mp4');
	const issue = completed.issues.find(issue => issue.code === 'nfo_missing')!;
	for (const ignored of [true, false]) {
		expect(repository.setMediaIssueIgnored(library.id, issue.path!, issue.code, issue.ignoreState!.fingerprint, ignored)).toBe(true);
		expect((await repository.getLibrary(library.id))!.warningCount).toBe(0);
	}
});

it.each([
	['<year>-1</year><premiered>2020-01-01</premiered>', true],
	['<year>-1</year>', false],
	['<rating>99</rating><ratings><rating><value>8</value></rating></ratings>', true],
	['<userrating>99</userrating>', false],
	['<actor><name>A</name><order>-1</order><sortorder>2</sortorder></actor><actor><name>B</name></actor>', true],
	['<actor><name>A</name><order>-1</order></actor>', false],
])('classifies recovered optional values from %s', async (fields, quiet) => {
	const { completed } = await fixture('movies', 'Film.mp4', `<movie>${fields}</movie>`);
	const issue = completed.issues.find(issue => issue.code === 'metadata_invalid') as ScanIssue;
	expect(Boolean(issue.informational)).toBe(quiet);
});


it('recovers group years from the show folder while retaining the invalid NFO field', async () => {
	const { completed, found } = await fixture(
		'shows',
		'Show (2020)/S01E01.mp4',
		'<episodedetails><title>Pilot</title></episodedetails>',
		'<tvshow><title>Show</title><year>-1</year></tvshow>',
	);
	expect(completed.issues.filter(scanIssueRequiresAttention)).toEqual([]);
	expect(completed.issues).toContainEqual(expect.objectContaining({ code: 'metadata_invalid', informational: true }));
	expect(found.groups.find(group => group.kind === 'show')!.year).toBe(2020);
});

it('recovers music-video year and track from existing filename fallbacks', async () => {
	const { completed, found } = await fixture('music-videos', '01 - Song (2020).mp4', '<musicvideo><year>-1</year><track>-1</track></musicvideo>');
	expect(completed.issues.filter(scanIssueRequiresAttention)).toEqual([]);
	expect(found.items[0]).toMatchObject({ year: 2020, trackNumber: 1 });
});


it('recovers music-video numeric metadata through measured container tags', async () => {
	const { completed, found } = await fixture(
		'music-videos',
		'Song.mp4',
		'<musicvideo><year>-1</year><disc>-1</disc><track>-1</track></musicvideo>',
		undefined,
		{ date: '2020', disc: '2', track: '3' },
	);
	expect(completed.issues.filter(scanIssueRequiresAttention)).toEqual([]);
	expect(found.items[0]).toMatchObject({ year: 2020, discNumber: 2, trackNumber: 3 });
});

it('keeps unresolved disc and track values actionable', async () => {
	const { completed } = await fixture('music-videos', 'Song.mp4', '<musicvideo><disc>-1</disc><track>-1</track></musicvideo>');
	expect(completed.issues.filter(scanIssueRequiresAttention)).toContainEqual(expect.objectContaining({
		code: 'metadata_invalid', message: expect.stringContaining('disc, track'),
	}));
});
