import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/** Repository root containing the vendored contract package. */
const projectRoot = path.resolve(import.meta.dirname, '..');
/** Destination for the pinned upstream worker schemas and examples. */
const vendorRoot = path.join(projectRoot, 'packages/ersatztv-contract/src/vendor');
/** File recording the exact upstream revision represented by the snapshot. */
const provenancePath = path.join(projectRoot, 'packages/ersatztv-contract/src/provenance.json');
/** ErsatzTV-Next checkout used only for developer compatibility checks. */
const sourceRoot = path.resolve(
	process.env.ETV_NEXT_DIR ?? path.join(projectRoot, 'vendor', 'ersatztv-next'),
);
/** Upstream worker files copied and checked as one compatibility snapshot. */
const trackedFiles = [
	'schema/channel_config.json',
	'schema/playout.json',
	'examples/channel.json',
	'examples/playout/playout.json',
	'LICENSE',
] as const;

/** Compute the content digest used to detect meaningful output changes. */
async function digest(file: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(file))
		.digest('hex');
}

/** Compare the pinned worker snapshot with the checked-out ErsatzTV contract. */
async function check(): Promise<boolean> {
	let matches = true;
	const provenance = JSON.parse(await readFile(provenancePath, 'utf8')) as { revision: string };
	let revision: string;
	try {
		revision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
			encoding: 'utf8',
		}).trim();
	}
	catch {
		console.error(`ErsatzTV Next is not initialized at ${sourceRoot}. Run npm run etv:setup.`);
		return false;
	}
	if (revision !== provenance.revision) {
		console.error(
			`ErsatzTV Next revision differs: expected ${provenance.revision}, found ${revision}`,
		);
		matches = false;
	}
	for (const relativePath of trackedFiles) {
		const source = path.join(sourceRoot, relativePath);
		const vendored = path.join(vendorRoot, relativePath);
		if ((await digest(source)) !== (await digest(vendored))) {
			console.error(`Contract differs: ${relativePath}`);
			matches = false;
		}
	}
	return matches;
}

/** Refresh the bundled ErsatzTV contract snapshot from the configured checkout. */
async function sync(): Promise<void> {
	const revision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
	}).trim();
	for (const relativePath of trackedFiles) {
		const destination = path.join(vendorRoot, relativePath);
		await mkdir(path.dirname(destination), { recursive: true });
		await copyFile(path.join(sourceRoot, relativePath), destination);
	}

	await writeFile(
		provenancePath,
		`${JSON.stringify(
			{
				repository: 'https://github.com/ErsatzTV/next',
				revision,
				syncedAt: new Date().toISOString().slice(0, 10),
				license: 'MIT',
			},
			null,
			2,
		)}\n`,
	);
	console.log(`Synced ErsatzTV-Next contract at ${revision}`);
}

/** Requested contract operation from the command line. */
const mode = process.argv[2];
if (mode === 'sync') {
	await sync();
}
else if (mode === 'check') {
	if (!(await check())) {
		process.exitCode = 1;
	}
}
else {
	console.error('Usage: npm run etv:check | npm run etv:sync');
	process.exitCode = 2;
}
