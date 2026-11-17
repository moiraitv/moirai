import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const exceptions = JSON.parse(readFileSync(join(root, '.nsprc'), 'utf8'));
const advisoryId = 'GHSA-fc5q-39xc-vjpf';
const npmCli = process.env.npm_execpath ?? realpathSync(join(dirname(process.execPath), 'npm'));

function auditReport(otherSeverity) {
	const via = [{
		source: 1247710,
		name: 'picomatch',
		dependency: 'picomatch',
		title: 'Repeated extglob denial of service',
		url: `https://github.com/advisories/${advisoryId}`,
		severity: 'high',
		range: '<=4.0.7',
	}];
	if (otherSeverity) {
		via.push({
			...via[0],
			source: 9999999,
			url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
			severity: otherSeverity,
		});
	}

	return {
		auditReportVersion: 2,
		vulnerabilities: {
			picomatch: {
				name: 'picomatch', severity: 'high', via, effects: ['vite'],
				range: '*', nodes: ['node_modules/picomatch'], fixAvailable: false,
			},
			vite: {
				name: 'vite', severity: 'high', via: ['picomatch'], effects: [],
				range: '*', nodes: ['node_modules/vite'], fixAvailable: false,
			},
		},
	};
}

function runGate({ report = auditReport(), exception = {}, auditExit = 1 } = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'moirai-production-gate-'));
	const log = join(directory, 'calls.jsonl');
	const policy = structuredClone(exceptions);
	policy[advisoryId].expiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
	Object.assign(policy[advisoryId], exception);

	try {
		writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
		writeFileSync(join(directory, '.nsprc'), JSON.stringify(policy));
		symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
		writeFileSync(join(directory, 'npm'), String.raw`#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(process.env.MOIRAI_GATE_LOG, JSON.stringify({
	args, include: process.env.npm_config_include,
}) + '\n');
if (args[0] === 'audit') {
	process.stdout.write(process.env.MOIRAI_GATE_REPORT);
	process.exit(Number(process.env.MOIRAI_GATE_AUDIT_EXIT));
}
if (args[0] === 'exec') {
	process.exit(spawnSync(process.execPath, [process.env.MOIRAI_GATE_NPM_CLI, ...args], {
		stdio: 'inherit',
	}).status ?? 1);
}
if (args[1] === 'security:audit') {
	process.exit(spawnSync(process.env.MOIRAI_GATE_AUDIT_SCRIPT, {
		shell: true, stdio: 'inherit',
	}).status ?? 1);
}
`, { mode: 0o755 });
		const result = spawnSync(scripts['build:production'], {
			cwd: directory,
			shell: true,
			env: {
				...process.env,
				PATH: `${directory}:${process.env.PATH}`,
				NODE_ENV: 'production',
				npm_config_omit: 'dev\noptional',
				npm_config_logs_max: '0',
				MOIRAI_GATE_LOG: log,
				MOIRAI_GATE_REPORT: typeof report === 'string' ? report : JSON.stringify(report),
				MOIRAI_GATE_AUDIT_EXIT: String(auditExit),
				MOIRAI_GATE_AUDIT_SCRIPT: scripts['security:audit'],
				MOIRAI_GATE_NPM_CLI: npmCli,
			},
			encoding: 'utf8',
			timeout: 10_000,
		});
		expect(result.error, result.stderr).toBeUndefined();
		expect(result.stderr).not.toContain('SyntaxError');
		const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
		return { ...result, calls };
	}
	finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe('production vulnerability gate', () => {
	it.each([
		['clean audit', { auditReportVersion: 2, vulnerabilities: {} }, 0],
		['active picomatch exception and its dependent findings', auditReport(), 1],
	])('compiles after an accepted audit: %s', (_scenario, report, auditExit) => {
		const result = runGate({ report, auditExit });

		expect(result.status, result.stderr).toBe(0);
		expect(result.calls.filter(call => call.args[0] === 'run').map(call => call.args[1])).toEqual([
			'security:audit', 'docs:user:review:check', 'build',
		]);
		const audit = result.calls.find(call => call.args[0] === 'audit');
		expect(audit).toBeDefined();
		expect(audit.include.split('\n')).toEqual(expect.arrayContaining(['dev', 'optional']));
	});

	it.each(['low', 'moderate', 'high', 'critical'])('blocks another %s advisory even in the excepted package', severity => {
		const result = runGate({ report: auditReport(severity) });

		expect(result.status, result.stderr).toBe(1);
		expect(result.calls.filter(call => call.args[0] === 'run').map(call => call.args[1])).toEqual(['security:audit']);
	});

	it.each([
		['expired', { expiry: new Date(0).toISOString() }],
		['inactive', { active: false }],
		['missing notes', { notes: '' }],
		['missing expiry', { expiry: null }],
		['invalid expiry', { expiry: 'invalid' }],
	])('blocks the finding when the exception is %s', (_scenario, exception) => {
		const result = runGate({ exception });

		expect(result.status, result.stderr).toBe(1);
		expect(result.calls.filter(call => call.args[0] === 'run').map(call => call.args[1])).toEqual(['security:audit']);
	});

	it.each([
		['audit service error', { error: { code: 'ECONNREFUSED' } }],
		['invalid response', 'not JSON'],
		['empty response', ''],
	])('blocks compilation on an %s', (_scenario, report) => {
		const result = runGate({ report, auditExit: 2 });

		expect(result.status, result.stderr).toBe(1);
		expect(result.calls.filter(call => call.args[0] === 'run').map(call => call.args[1])).toEqual(['security:audit']);
	});
});
