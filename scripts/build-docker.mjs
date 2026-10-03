import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Always build this checkout rather than relying on the caller's working directory. */
const root = fileURLToPath(new URL('../', import.meta.url));
/** Options for a local image; release workflows continue to use the gated Dockerfile defaults. */
const usage = `Usage: npm run build:docker -- [options]

  --tag IMAGE          Image tag (default: moirai:local)
  --platform PLATFORM  Target platform (default: linux/amd64)
  --skip-build-checks   Bypass dependency audit and documentation approvals
  --help               Show this help

Compilation and dependency installation still run when checks are skipped.
`;

/** Validate explicit options before invoking Docker, preserving arguments without a shell. */
function build() {
	const args = process.argv.slice(2);
	let tag = 'moirai:local';
	let platform = 'linux/amd64';
	let skipChecks = false;
	for (let index = 0; index < args.length; index++) {
		const option = args[index];
		if (option === '--help') {
			console.log(usage);
			return 0;
		}
		if (option === '--skip-build-checks') {
			skipChecks = true;
		}
		else if (option === '--tag' || option === '--platform') {
			const value = args[++index];
			if (!value || value.startsWith('-')) {
				throw new Error(`${option} requires a value`);
			}
			if (option === '--tag') {
				tag = value;
			}
			else {
				platform = value;
			}
		}
		else {
			throw new Error(`Unknown option: ${option}\n${usage}`);
		}
	}

	const result = spawnSync('docker', [
		'build', '--tag', tag, '--platform', platform,
		'--build-arg', `MOIRAI_SKIP_BUILD_CHECKS=${skipChecks}`, '.',
	], { cwd: root, stdio: 'inherit' });
	if (result.error) {
		throw result.error;
	}
	return result.status ?? 1;
}

try {
	process.exitCode = build();
}
catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
