import type { ScanIssue } from '@moirai/shared';
import type { ParsedNfo } from './nfo.js';

/** Resolved catalog values determine whether rejected NFO fields still need attention. */
export interface MetadataDiagnosticContext {
	group?: boolean;
	typeKey?: string;
	year?: number | null;
	seasonNumber?: number | null;
	episodeNumber?: number | null;
	discNumber?: number | null;
	trackNumber?: number | null;
}

/** Keep unused, superseded, or successfully recovered numeric fields out of library health. */
function isHarmlessField(field: string, parsed: ParsedNfo, context: MetadataDiagnosticContext): boolean {
	switch (field) {
		case 'runtime':
		case 'width':
		case 'height':
			return true;
		case 'season':
			return Boolean(context.group) || context.typeKey !== 'shows' || context.seasonNumber != null;
		case 'episode':
			return Boolean(context.group) || context.typeKey !== 'shows' || context.episodeNumber != null;
		case 'year':
			return (parsed.year ?? context.year) != null;
		case 'disc':
			return Boolean(context.group) || context.discNumber != null;
		case 'track':
			return Boolean(context.group) || context.trackNumber != null;
		case 'rating':
			return typeof parsed.metadata.rating === 'number';
		case 'userRating':
			return typeof parsed.metadata.userRating === 'number';
		case 'actorOrder':
			return !parsed.hasUnresolvedActorOrder;
		default:
			return false;
	}
}

/** Retain every rejected or bounded field, separating attention-worthy fields from quiet findings. */
export function metadataDiagnostics(parsed: ParsedNfo, path: string, context: MetadataDiagnosticContext): ScanIssue[] {
	const issues: ScanIssue[] = [];
	for (const code of ['metadata_invalid', 'metadata_truncated'] as const) {
		const fields = code === 'metadata_invalid' ? parsed.invalidFields : parsed.truncatedFields;
		for (const informational of [false, true]) {
			const selected = fields.filter(field => (code === 'metadata_invalid'
				? isHarmlessField(field, parsed, context)
				: field !== 'uniqueId') === informational);
			if (selected.length > 0) {
				issues.push({
					path,
					code,
					message: code === 'metadata_invalid'
						? `Invalid metadata values were ignored: ${selected.join(', ')}.`
						: `Metadata exceeded documented limits: ${selected.join(', ')}.`,
					severity: 'warning',
					...(informational ? { informational: true } : {}),
				});
			}
		}
	}
	return issues;
}

/** Missing sidecars are quiet only when the existing fallback supplies usable catalog identity. */
export function classifyMissingNfo(issue: ScanIssue, title: string, context: MetadataDiagnosticContext): ScanIssue {
	const usableIdentity = Boolean(title.trim()) && (context.typeKey !== 'shows'
		|| (context.seasonNumber != null && context.episodeNumber != null));
	return issue.code === 'nfo_missing' && usableIdentity ? { ...issue, informational: true } : issue;
}
