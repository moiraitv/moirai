import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Repository root containing the pinned development checkout. */
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Git submodule used when no alternate Next checkout is configured. */
const submoduleRoot = path.join(projectRoot, 'vendor', 'ersatztv-next');
/** Recorded upstream compatibility revision. */
const provenancePath = path.join(
	projectRoot,
	'packages',
	'ersatztv-contract',
	'src',
	'provenance.json',
);

/** Run a command with inherited output and fail when it does not complete successfully. */
function run(command, args, cwd = projectRoot) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: 'inherit',
	});
	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
	}
}

/** Read the revision represented by Moirai's checked-in compatibility snapshot. */
function expectedRevision() {
	return JSON.parse(readFileSync(provenancePath, 'utf8')).revision;
}

/** Read the current commit from an initialized ErsatzTV Next checkout. */
function checkoutRevision(sourceRoot) {
	const result = spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		throw new Error(`ErsatzTV Next is not initialized at ${sourceRoot}. Run npm run etv:setup.`);
	}

	return result.stdout.trim();
}

/** Ensure development uses the same Next revision as the compatibility snapshot. */
function verifyRevision(sourceRoot) {
	const expected = expectedRevision();
	const actual = checkoutRevision(sourceRoot);
	if (actual !== expected) {
		throw new Error(`ErsatzTV Next must be at ${expected}; found ${actual} in ${sourceRoot}`);
	}
}

/** Initialize the pinned Next submodule without building it implicitly. */
function setup() {
	run('git', ['submodule', 'sync', '--', 'vendor/ersatztv-next']);
	run('git', ['submodule', 'update', '--init', '--checkout', '--', 'vendor/ersatztv-next']);
	verifyRevision(submoduleRoot);
	console.log(`ErsatzTV Next is ready at ${expectedRevision()}.`);
}

/** Build the standalone channel worker from the configured or pinned checkout. */
function build() {
	const sourceRoot = path.resolve(process.env.ETV_NEXT_DIR?.trim() || submoduleRoot);
	if (!existsSync(path.join(sourceRoot, 'Cargo.toml'))) {
		throw new Error(`ErsatzTV Next is not initialized at ${sourceRoot}. Run npm run etv:setup.`);
	}

	verifyRevision(sourceRoot);
	run(
		process.platform === 'win32' ? 'cargo.exe' : 'cargo',
		[
			'build',
			'--release',
			'--manifest-path',
			path.join(sourceRoot, 'Cargo.toml'),
			'-p',
			'ersatztv-channel',
		],
	);
}

/** Requested development checkout operation. */
const mode = process.argv[2];
try {
	if (mode === 'setup') {
		setup();
	}
	else if (mode === 'build') {
		build();
	}
	else {
		console.error('Usage: npm run etv:setup | npm run etv:build');
		process.exitCode = 2;
	}
}
catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
