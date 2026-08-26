import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { MediaSubtitleTrack } from '@moirai/shared';
import type { MediaProbeResult } from '../media/media-probe.js';

/** Sidecar subtitle suffixes retained for future playback selection. */
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.sup']);

/** Located subtitle track together with absolute files needed for fingerprinting. */
export interface LocatedSubtitleTrack {
	track: MediaSubtitleTrack;
	absolutePaths: string[];
}

/** One physical media stem eligible to own part-scoped sidecars. */
export interface SubtitlePartCandidate {
	stem: string;
	partNumber: number;
}

/** Normalize a source-relative path to portable separators. */
function relative(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join('/');
}

/** Return a stable track identifier from its complete source identity. */
function trackId(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

/** Convert probed subtitle streams into stable part-scoped inventory records. */
export function embeddedSubtitleTracks(
	probe: MediaProbeResult | null,
	partNumber: number,
	relativePath: string,
): MediaSubtitleTrack[] {
	return (probe?.streams ?? [])
		.filter((stream) => stream.type === 'subtitle')
		.map((stream) => ({
			id: trackId(`embedded:${relativePath}:${stream.index}`),
			sourceType: 'embedded' as const,
			partNumber,
			streamIndex: stream.index,
			codec: stream.codec,
			format: null,
			language: stream.language,
			title: stream.title,
			isDefault: stream.isDefault,
			isForced: stream.isForced,
			isHearingImpaired: stream.isHearingImpaired,
			isCommentary: stream.isCommentary,
			relativePaths: [],
			playbackPaths: [],
		}));
}

/** Parse language and disposition tokens between a media stem and subtitle extension. */
function subtitleTokens(value: string): {
	language: string | null;
	isDefault: boolean;
	isForced: boolean;
} {
	const tokens = value.split('.').map((token) => token.trim()).filter(Boolean);
	const flags = new Set(tokens.map((token) => token.toLocaleLowerCase('en-US')));
	const language = tokens.find((token) => !['default', 'forced'].includes(token.toLocaleLowerCase('en-US')));
	return {
		language: language?.toLocaleLowerCase('en-US') ?? null,
		isDefault: flags.has('default'),
		isForced: flags.has('forced'),
	};
}

/** Discover safe sidecar subtitle files associated with one logical item and its physical parts. */
export async function discoverSidecarSubtitles(
	scanRoot: string,
	logicalStem: string,
	parts: SubtitlePartCandidate[],
	playbackPath: (relativePath: string) => string,
): Promise<LocatedSubtitleTrack[]> {
	const directories = [...new Set([logicalStem, ...parts.map((part) => part.stem)].map(path.dirname))];
	const files: string[] = [];
	for (const directory of directories) {
		let entries;
		try {
			entries = await readdir(directory, { withFileTypes: true });
		}
		catch {
			continue;
		}

		for (const entry of entries) {
			if (entry.isFile() && SUBTITLE_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase('en-US'))) {
				files.push(path.join(directory, entry.name));
			}
		}
	}

	const logicalKey = path.normalize(logicalStem).toLocaleLowerCase('en-US');
	const partKeys = parts
		.map((part) => ({ ...part, key: path.normalize(part.stem).toLocaleLowerCase('en-US') }))
		.sort((left, right) => right.key.length - left.key.length);
	const candidates = new Map<string, {
		absolutePaths: string[];
		basePath: string;
		partNumber: number | null;
		tokens: ReturnType<typeof subtitleTokens>;
		extensions: Set<string>;
	}>();

	for (const file of files) {
		const extension = path.extname(file).toLocaleLowerCase('en-US');
		const withoutExtension = file.slice(0, -path.extname(file).length);
		const normalized = path.normalize(withoutExtension).toLocaleLowerCase('en-US');
		const part = partKeys.find((candidate) =>
			normalized === candidate.key || normalized.startsWith(`${candidate.key}.`));
		const baseKey = part?.key ?? logicalKey;
		if (!(normalized === baseKey || normalized.startsWith(`${baseKey}.`))) {
			continue;
		}

		const suffix = withoutExtension.slice(baseKey.length).replace(/^\./, '');
		const pairable = extension === '.idx' || extension === '.sub';
		const key = `${withoutExtension.toLocaleLowerCase('en-US')}:${part?.partNumber ?? 'logical'}${pairable ? '' : `:${extension}`}`;
		const existing = candidates.get(key);
		if (existing) {
			existing.absolutePaths.push(file);
			existing.extensions.add(extension);
		}
		else {
			candidates.set(key, {
				absolutePaths: [file],
				basePath: withoutExtension,
				partNumber: part?.partNumber ?? null,
				tokens: subtitleTokens(suffix),
				extensions: new Set([extension]),
			});
		}
	}

	return [...candidates.values()]
		.sort((left, right) => left.basePath.localeCompare(right.basePath))
		.map((candidate) => {
			const relativePaths = candidate.absolutePaths.map((file) => relative(scanRoot, file)).sort();
			const vobsub = candidate.extensions.has('.idx') && candidate.extensions.has('.sub');
			const format = vobsub
				? 'vobsub'
				: [...candidate.extensions][0]!.slice(1).toLocaleLowerCase('en-US');
			return {
				absolutePaths: candidate.absolutePaths,
				track: {
					id: trackId(`sidecar:${relativePaths.join(':')}`),
					sourceType: 'sidecar',
					partNumber: candidate.partNumber,
					streamIndex: null,
					codec: vobsub ? 'dvd_subtitle' : null,
					format,
					language: candidate.tokens.language,
					title: null,
					isDefault: candidate.tokens.isDefault,
					isForced: candidate.tokens.isForced,
					isHearingImpaired: false,
					isCommentary: false,
					relativePaths,
					playbackPaths: relativePaths.map(playbackPath),
				},
			};
		});
}
