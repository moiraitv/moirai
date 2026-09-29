import { realpath, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import sharp from 'sharp';
import type Database from 'better-sqlite3';

/** One validated catalog selection with its model-reported tier. */
export interface ReportItem {
	id: string;
	title: string;
	year: number | null;
	plot: string | null;
	poster: string | null;
	tier: 'core' | 'supporting';
}

/** Safe, compact facts retained for a single paid production-path run. */
export interface ReportRun {
	name: string;
	model: string;
	settings: Record<string, unknown>;
	status: 'completed' | 'failed' | 'preflight failed' | 'budget limited';
	durationMs: number;
	reviewedCount: number | null;
	selectedCount: number;
	inputTokens: number | null;
	outputTokens: number | null;
	estimatedCostUsd: number;
	reviewStoppedEarly: boolean;
	finalReviewIncomplete: boolean;
	localDiscoveryFallback?: boolean;
	failurePhase?: string;
	failureCategory?: string;
	items: ReportItem[];
	error?: string;
}

/** Escape catalog and provider labels before interpolating them into local HTML. */
export function escapeHtml(value: string): string {
	return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
		.replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
}

/** Bound plot copy to 100 Unicode characters including its truncation marker. */
export function plotExcerpt(value: string | null): string {
	const points = Array.from((value ?? '').trim().replace(/\s+/gu, ' '));
	return points.length > 100 ? `${points.slice(0, 99).join('')}…` : points.join('');
}

/** Show effective protocol defaults while omitting any accidental secret-valued option. */
export function displayedSettings(settings: Record<string, unknown>): string {
	const protocol = settings.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'chat-completions';
	const display = { protocol, jsonMode: protocol === 'anthropic-messages' ? 'native JSON schema'
		: settings.chatJsonMode ?? 'json_object', ...settings };
	return JSON.stringify(display, (key, value: unknown) =>
		/^(?:api_?key|authorization|credentials?|secret|access_?token|auth_?token)$/iu.test(key) ? undefined : value, 2);
}

/** Embed only artwork located beneath the configured development scan root. */
export async function posterData(scanRoot: string, posterPath: string | null): Promise<string | null> {
	if (!posterPath || isAbsolute(posterPath)) {
		return null;
	}
	try {
		const root = await realpath(scanRoot);
		const candidate = await realpath(resolve(root, posterPath));
		const inside = relative(root, candidate);
		if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
			return null;
		}
		const source = await readFile(candidate);
		const thumbnail = await sharp(source).resize(96, 144, { fit: 'cover' }).webp({ quality: 72 }).toBuffer();
		return `data:image/webp;base64,${thumbnail.toString('base64')}`;
	}
	catch {
		return null;
	}
}

/** Read selected items in their actual output order and attach local poster thumbnails. */
export async function reportItems(
	sqlite: Database.Database, 
	libraryId: string, 
	scanRoot: string,
	coreItemIds: string[], 
	supportingItemIds: string[],
): Promise<ReportItem[]> {
	const lookup = sqlite.prepare(`SELECT id, title, year, plot, poster_relative_path AS posterPath
		FROM media_items WHERE library_id=? AND id=?`);
	const items: ReportItem[] = [];
	for (const [tier, ids] of [['core', coreItemIds], ['supporting', supportingItemIds]] as const) {
		for (const id of ids) {
			const row = lookup.get(libraryId, id) as { id: string; title: string; year: number | null;
				plot: string | null; posterPath: string | null } | undefined;
			if (!row) {
				throw new Error('A selected item is missing from the development library.');
			}
			items.push({ id, title: row.title, year: row.year, plot: plotExcerpt(row.plot),
				poster: await posterData(scanRoot, row.posterPath), tier });
		}
	}
	return items;
}

/** Render a self-contained comparison with independent, horizontally scrollable model columns. */
export function renderComparisonHtml(
	prompt: string, 
	libraryName: string, 
	runs: ReportRun[], 
	capUsd: number,
	estimatedTotalUsd: number,
): string {
	const card = (item: ReportItem): string => `<article class="item"><div class="poster">${item.poster
		? `<img src="${item.poster}" alt="" loading="lazy">` : '<span>NO POSTER</span>'}</div><div class="copy"><h4>${escapeHtml(item.title)}${item.year === null ? '' : ` <small>${item.year}</small>`}</h4><p>${escapeHtml(plotExcerpt(item.plot) || 'Plot unavailable.')}</p></div></article>`;
	const columns = runs.map(run => {
		const stats = `<div class="stats"><span>${Math.round(run.durationMs / 1000)}s</span><span>${run.reviewedCount ?? '—'} reviewed</span><span>${run.selectedCount} selected</span><span>${run.inputTokens ?? '—'} in / ${run.outputTokens ?? '—'} out</span><span>$${run.estimatedCostUsd.toFixed(3)} estimated</span></div>`;
		const warnings = [run.reviewStoppedEarly ? 'Review stopped early; plausible titles may remain unchecked.' : '',
			run.finalReviewIncomplete ? 'Final refinement was incomplete; validated batch picks were used.' : '',
			run.localDiscoveryFallback ? 'Model planning was unavailable; local prompt matching supplied the shortlist.' : ''].filter(Boolean);
		const section = (tier: 'core' | 'supporting', label: string): string => `<section><h3>${label} <small>${run.items.filter(item => item.tier === tier).length}</small></h3>${run.items.filter(item => item.tier === tier).map(card).join('') || '<p class="empty">No matches</p>'}</section>`;
		return `<div class="column"><div class="model"><h2>${escapeHtml(run.name)}</h2><div class="model-id">${escapeHtml(run.model)}</div><div class="status ${run.status === 'completed' ? 'ok' : 'bad'}">${escapeHtml(run.status)}</div>${stats}${warnings.map(value => `<p class="warning">${escapeHtml(value)}</p>`).join('')}<details><summary>Request settings</summary><pre>${escapeHtml(displayedSettings(run.settings))}</pre></details></div>${run.status === 'completed'
			? `${section('core', 'Core')}${section('supporting', 'Additional')}`
			: `<div class="error">${run.failurePhase ? `${escapeHtml(run.failurePhase)}${run.failureCategory ? ` · ${escapeHtml(run.failureCategory)}` : ''}<br>` : ''}${escapeHtml(run.error ?? 'Generation did not complete.')}</div>`}</div>`;
	}).join('');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Five-model selection comparison</title><style>
	:root{font:14px/1.45 system-ui,sans-serif;color:#e9eff8;background:#0b1421}*{box-sizing:border-box}body{margin:0}header{padding:28px 32px;border-bottom:1px solid #304052}h1{font-size:24px;margin:0 0 8px}header p{color:#aebed0;margin:7px 0;max-width:1100px}.prompt{color:#e4ebf5}main{display:flex;gap:14px;overflow-x:auto;padding:20px 24px 40px;align-items:flex-start}.column{flex:0 0 340px;background:#101e2e;border:1px solid #304052;border-radius:12px;min-height:80vh;overflow:hidden}.model{padding:16px;position:sticky;top:0;background:#14263a;z-index:1;border-bottom:1px solid #304052}.model h2{font-size:18px;margin:0}.model-id{font-size:11px;color:#aebed0;overflow-wrap:anywhere}.status{display:inline-block;padding:3px 8px;margin:10px 0;border-radius:99px;text-transform:capitalize}.ok{background:#194a3b;color:#b8f5d6}.bad{background:#5a2b32;color:#ffe1e1}.stats{display:flex;flex-wrap:wrap;gap:6px}.stats span{background:#24364a;padding:3px 6px;border-radius:5px;font-size:11px}.warning{color:#ffd89a;margin:8px 0 0;font-size:12px}details{margin-top:10px;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#b9cadd}section{padding:4px 12px}section h3{font-size:15px;border-bottom:1px solid #304052;padding-bottom:7px}.item{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #273648}.poster{flex:0 0 58px;width:58px;height:87px;background:#2b3a4b;display:grid;place-items:center;color:#a9b8ca;font-size:9px;text-align:center}.poster img{width:100%;height:100%;object-fit:cover}.copy{min-width:0}.copy h4{margin:0 0 4px;font-size:13px}.copy small{color:#aebed0;font-weight:400}.copy p{margin:0;color:#acbbcd;font-size:11px}.empty,.error{padding:12px;color:#b5c4d4}.error{margin:14px;border:1px solid #92545b;border-radius:8px;color:#ffdadf}
	</style></head><body><header><h1>Five-model Movies selection</h1><p>Library: ${escapeHtml(libraryName)} · Result ceiling: 200 · Production deadline: 5 minutes · Conservative reserved spend: $${estimatedTotalUsd.toFixed(3)} / $${capUsd.toFixed(2)}</p><p class="prompt">${escapeHtml(prompt)}</p><p>Core and Additional are the models’ reported tiers, not independent quality judgments. Costs are conservative estimates; provider billing can differ.</p></header><main>${columns}</main></body></html>`;
}
