import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphicsAsset } from '@moirai/shared';
import { graphicsAssetPath, runGraphicsProcess } from './assets.js';

/** Give every selected asset a private family name for this render. */
export function graphicsFontAlias(id: string): string {
	return `MoiraiGraphics-${id}`;
}

/** Escape private paths embedded in a Fontconfig XML document. */
function xmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Render custom faces in a disposable process with per-file Fontconfig family aliases. */
export async function renderWithGraphicsFonts(root: string, markup: string, assets: GraphicsAsset[]): Promise<Buffer> {
	const folder = await mkdtemp(path.join(os.tmpdir(), 'moirai-graphics-fonts-'));
	try {
		const rules = [];
		for (const asset of assets) {
			const copy = path.join(folder, `${asset.id}.${asset.format}`);
			await copyFile(await graphicsAssetPath(root, asset), copy);
			rules.push(`<match target="scan"><test name="file" compare="eq"><string>${xmlText(copy)}</string></test><edit name="family" mode="assign_replace"><string>${graphicsFontAlias(asset.id)}</string></edit></match>`);
		}
		const config = path.join(folder, 'graphics.conf');
		const input = path.join(folder, 'markup.txt');
		const system = process.env.FONTCONFIG_FILE || 'fonts.conf';
		await Promise.all([
			writeFile(input, markup, { mode: 0o600 }),
			writeFile(config, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><cachedir>${xmlText(path.join(folder, 'cache'))}</cachedir><include ignore_missing="yes">${xmlText(system)}</include><dir>${xmlText(folder)}</dir>${rules.join('')}</fontconfig>`),
		]);
		const compiled = fileURLToPath(new URL('./graphics-font-worker.js', import.meta.url));
		const args = existsSync(compiled) ? [compiled] : ['--import', 'tsx', fileURLToPath(new URL('./font-worker.ts', import.meta.url))];
		const { stdout } = await runGraphicsProcess(process.execPath, [...args, input], {
			encoding: 'buffer', timeout: 5000, maxBuffer: 12 * 1024 * 1024,
			env: { ...process.env, FONTCONFIG_FILE: config, PANGOCAIRO_BACKEND: 'fontconfig' },
		});
		return stdout;
	}
	finally {
		await rm(folder, { recursive: true, force: true });
	}
}
