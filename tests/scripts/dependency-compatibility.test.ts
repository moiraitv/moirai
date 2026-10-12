import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const matterRequire = createRequire(require.resolve('gray-matter'));
const yamlRoot = dirname(matterRequire.resolve('js-yaml/package.json'));
const runtimeRoot = dirname(require.resolve('onnxruntime-node/package.json'));

it('keeps the legacy YAML CLI working with the patched dependency tree', () => {
	const cli = join(yamlRoot, 'bin/js-yaml.js');
	const output = execFileSync(process.execPath, [cli], {
		input: 'title: Playback order\nenabled: true\nitems:\n  - episode\n', encoding: 'utf8',
	});
	expect(JSON.parse(output)).toEqual({ title: 'Playback order', enabled: true, items: ['episode'] });
	expect(execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })).toContain('--compact');
});

it('runs the real ONNX installer bootstrap with the updated proxy agent', () => {
	expect(() => execFileSync(process.execPath, [join(runtimeRoot, 'script/install.js')], {
		env: { ...process.env, ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' },
		stdio: 'pipe',
	})).not.toThrow();
});

it('routes installer HTTP requests through the configured proxy', () => {
	const output = execFileSync(process.execPath, ['-e', `
		const http = require('node:http');
		const { createRequire } = require('node:module');
		const runtimeRequire = createRequire(${JSON.stringify(join(runtimeRoot, 'package.json'))});
		const proxy = http.createServer((request, response) => {
			response.end(request.url);
		});
		proxy.listen(0, '127.0.0.1', () => {
			process.env.GLOBAL_AGENT_HTTP_PROXY = 'http://127.0.0.1:' + proxy.address().port;
			process.env.GLOBAL_AGENT_NO_PROXY = '';
			runtimeRequire('global-agent').bootstrap();
			http.get('http://installer.invalid/model', response => {
				response.pipe(process.stdout);
				response.on('end', () => proxy.close());
			}).on('error', error => { console.error(error); process.exit(1); });
		});
	`], { encoding: 'utf8', timeout: 10_000 });
	expect(output).toBe('http://installer.invalid/model');
});
