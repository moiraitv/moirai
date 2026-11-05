import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/build-docker.mjs', import.meta.url));
const directories = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), 'moirai-docker-build-'));
	directories.push(directory);
	const log = join(directory, 'calls.jsonl');
	writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
	writeFileSync(join(directory, 'docker'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.MOIRAI_BUILD_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
process.stdout.write(process.env.MOIRAI_BUILD_STDOUT ?? '');
process.stderr.write(process.env.MOIRAI_BUILD_STDERR ?? '');
process.exitCode = Number(process.env.MOIRAI_BUILD_EXIT ?? 0);
`, { mode: 0o755 });
	const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOIRAI_BUILD_LOG: log };
	return { directory, log, env };
}

it('builds the checkout with gates enabled by default, independent of the working directory', () => {
	const f = fixture();
	const result = spawnSync(process.execPath, [script], { cwd: f.directory, env: f.env, encoding: 'utf8' });
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(readFileSync(f.log, 'utf8'))).toEqual({
		cwd: root.replace(/\/$/, ''),
		args: ['build', '--tag', 'moirai:local', '--platform', 'linux/amd64', '--build-arg', 'MOIRAI_SKIP_BUILD_CHECKS=false', '.'],
	});
});

it('passes the explicit bypass and custom image options as separate arguments and propagates failures', () => {
	const f = fixture();
	const buildError = 'error during build: compilation failed\n';
	const result = spawnSync(process.execPath, [script, '--skip-build-checks', '--tag', 'moirai:test', '--platform', 'linux/amd64'], {
		env: { ...f.env, MOIRAI_BUILD_EXIT: '7', MOIRAI_BUILD_STDERR: buildError }, encoding: 'utf8',
	});
	expect(result.status).toBe(7);
	expect(result.stderr).toBe(buildError);
	expect(JSON.parse(readFileSync(f.log, 'utf8')).args).toEqual([
		'build', '--tag', 'moirai:test', '--platform', 'linux/amd64', '--build-arg', 'MOIRAI_SKIP_BUILD_CHECKS=true', '.',
	]);
});

it.each([
	['stdout', "[vite:prepare-out-dir] ENOSPC: mkdir '/app/apps/web/dist'\n"],
	['stderr', 'failed to solve: write /app/node_modules: no space left on device\n'],
])('highlights disk exhaustion reported on Docker %s and preserves the failure status', (stream, buildError) => {
	const f = fixture();
	const outputKey = `MOIRAI_BUILD_${stream.toUpperCase()}`;
	const result = spawnSync(process.execPath, [script], {
		env: { ...f.env, MOIRAI_BUILD_EXIT: '7', [outputKey]: buildError }, encoding: 'utf8',
	});

	expect(result.status).toBe(7);
	expect(result[stream]).toMatch(buildError);
	expect(result.stderr).toContain('Docker build ran out of disk space');
	expect(result.stderr).toContain('docker system df');
});

it.each([['--unknown'], ['--tag'], ['--platform', '--skip-build-checks']])('rejects malformed options before starting Docker: %s', (...args) => {
	const f = fixture();
	const result = spawnSync(process.execPath, [script, ...args], { env: f.env, encoding: 'utf8' });
	expect(result.status).toBe(1);
	expect(existsSync(f.log)).toBe(false);
});

it('shows help without requiring Docker', () => {
	const f = fixture();
	const result = spawnSync(process.execPath, [script, '--help'], { env: f.env, encoding: 'utf8' });
	expect(result.status).toBe(0);
	expect(result.stdout).toContain('--skip-build-checks');
	expect(existsSync(f.log)).toBe(false);
});

it.each([
	['false', 0, ['build:production']],
	['true', 0, ['build']],
	['invalid', 1, []],
])('executes the Dockerfile build-stage gate with %s', (value, status, commands) => {
	const f = fixture();
	writeFileSync(join(f.directory, 'npm'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.MOIRAI_BUILD_LOG, process.argv[3] + '\\n');
`, { mode: 0o755 });
	const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
	const stage = dockerfile.split('FROM dependencies AS build')[1].split('\nFROM ')[0];
	const command = stage.slice(stage.indexOf('RUN ') + 4).trim().replace(/\\\n/g, '\n');
	const result = spawnSync('/bin/sh', ['-c', command], {
		env: { ...f.env, MOIRAI_SKIP_BUILD_CHECKS: value }, encoding: 'utf8',
	});
	expect(result.status, result.stderr).toBe(status);
	const actual = existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n') : [];
	expect(actual).toEqual(commands);
});
