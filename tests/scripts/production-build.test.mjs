import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const { scripts } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

describe('production vulnerability gate', () => {
	it.each([
		['clean audit', 0],
		['reported vulnerabilities', 1],
		['audit service failure', 2],
	])('only compiles after a successful audit: %s', (_scenario, auditExit) => {
		const directory = mkdtempSync(join(tmpdir(), 'moirai-production-gate-'));
		const log = join(directory, 'calls.jsonl');
		const stub = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.MOIRAI_GATE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'audit') {
	process.exit(Number(process.env.MOIRAI_GATE_AUDIT_EXIT));
}
if (args[1] === 'security:audit') {
	process.exit(spawnSync(process.env.MOIRAI_GATE_AUDIT_SCRIPT, { shell: true, stdio: 'inherit' }).status ?? 1);
}
`;

		try {
			writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
			writeFileSync(join(directory, 'npm'), stub, { mode: 0o755 });
			const result = spawnSync(scripts['build:production'], {
				shell: true,
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH}`,
					MOIRAI_GATE_LOG: log,
					MOIRAI_GATE_AUDIT_EXIT: String(auditExit),
					MOIRAI_GATE_AUDIT_SCRIPT: scripts['security:audit'],
				},
				encoding: 'utf8',
			});
			const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));

			expect(result.status, result.stderr).toBe(auditExit);
			expect(calls).toEqual([
				['run', 'security:audit'],
				['audit', '--audit-level=low', '--include=dev', '--include=optional'],
				...(auditExit === 0 ? [['run', 'docs:user:review:check'], ['run', 'build']] : []),
			]);
		}
		finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
