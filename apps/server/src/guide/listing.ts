import { metadataProgramIds } from '../scheduling/program-metadata.js';
import { mergeProgramMetadata, type GuideEntry, type ProgramMetadata, type SchedulableMedia, type SchedulingCatalog, type TimelineSegment } from '@moirai/shared';
import {
	channelContext, listingTitle, mediaItemContext, programmeContext, programmeKind, renderProgrammeFragment,
	type CompiledGuideTemplate, type GuideRenderOptions,
} from './xmltv-template.js';

/** Render a single listing with the same Liquid values for published XMLTV and overlay labels. */
export async function renderGuideListing(
	entry: GuideEntry,
	segment: TimelineSegment | undefined,
	media: SchedulableMedia | undefined,
	catalog: SchedulingCatalog,
	channel: ReturnType<typeof channelContext>,
	timeZone: string,
	publicUrl: string,
	compiled: CompiledGuideTemplate,
	options: GuideRenderOptions,
	programMetadata?: ReadonlyMap<string, ProgramMetadata>,
	formatTime?: (instant: string) => string,
): Promise<{ xml: string; context: Record<string, unknown>; programIds: readonly string[] } | null> {
	const kind = programmeKind(entry, segment, media);
	if (kind !== 'block' && !segment) {
		return null;
	}

	const { start, finish } = entry;
	const context = programmeContext({
		kind, title: listingTitle(kind, entry, segment, media, catalog), start, finish, timeZone, channel,
		item: mediaItemContext(media, catalog, publicUrl),
		slot: {
			start, finish, role: segment?.role ?? entry.role, title: segment?.title ?? entry.title,
			program_id: segment?.programId ?? entry.programId, truncated: segment?.truncated ?? entry.truncated,
		},
		block: kind === 'block' ? {
			title: entry.title, description: entry.description,
			artwork_url: entry.posterUrl ? new URL(entry.posterUrl, `${publicUrl}/`).href : null,
		} : null,
	}, formatTime);
	const programIds = metadataProgramIds(kind === 'block' ? entry : segment);
	const program = { metadata: mergeProgramMetadata(programIds.map(id => programMetadata?.get(id))) };
	const xml = await renderProgrammeFragment(compiled, kind, { ...context, program }, options);
	return { xml, context, programIds };
}
