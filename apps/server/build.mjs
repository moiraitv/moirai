import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = path.dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: {
		'auth-reset': path.join(directory, 'src/auth-reset.ts'),
		main: path.join(directory, 'src/main.ts'),
		worker: path.join(directory, 'src/scheduling/worker.ts'),
	},
	outdir: path.join(directory, 'dist'),
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node24',
	sourcemap: true,
	packages: 'external',
	alias: {
		'@moirai/shared/api-contracts': path.resolve(
			directory,
			'../../packages/shared/src/api-contracts.ts',
		),
		'@moirai/shared': path.resolve(directory, '../../packages/shared/src/index.ts'),
		'@moirai/ersatztv-contract': path.resolve(
			directory,
			'../../packages/ersatztv-contract/src/index.ts',
		),
	},
});
