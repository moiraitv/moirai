import { spawn } from 'node:child_process';
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

/** Recognize explicit disk exhaustion in Docker and build-step errors. */
const diskSpaceError = /\bENOSPC\b|no space left on device/i;

/** Stream Docker's logs and summarize disk exhaustion after a failed build. */
function runDockerBuild(tag, platform, skipChecks) {
	return new Promise((resolve, reject) => {
		const docker = spawn('docker', [
			'build', '--tag', tag, '--platform', platform,
			'--build-arg', `MOIRAI_SKIP_BUILD_CHECKS=${skipChecks}`, '.',
		], { cwd: root, stdio: ['inherit', 'pipe', 'pipe'] });
		let outOfSpace = false;

		for (const [output, destination] of [[docker.stdout, process.stdout], [docker.stderr, process.stderr]]) {
			let tail = '';
			output.setEncoding('utf8');
			output.on('data', (chunk) => {
				const text = tail + chunk;
				outOfSpace ||= diskSpaceError.test(text);
				tail = text.slice(-'no space left on device'.length);
			});
			output.pipe(destination, { end: false });
		}

		docker.once('error', reject);
		docker.once('close', (status) => {
			if (status !== 0 && outOfSpace) {
				console.error('\nDocker build ran out of disk space. Check builder storage with "docker system df" and free up space before retrying.');
			}
			resolve(status ?? 1);
		});
	});
}

/** Validate explicit options before invoking Docker, preserving arguments without a shell. */
async function build() {
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

	return runDockerBuild(tag, platform, skipChecks);
}

try {
	process.exitCode = await build();
}
catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
