import { createHash } from 'node:crypto';
import path from 'node:path';
import type { MediaSubtitleTrack, ScanIssue } from '@moirai/shared';
import type { DiscoveredItem } from '../repository/contracts.js';
import { parseVideoFilename } from './video-filename.js';

/** Collapse physical multipart members into logical catalog items and retain legacy ID aliases. */
export function collapseMultipartItems(
	items: DiscoveredItem[],
	issues: ScanIssue[],
	typeKey: string,
): void {
	const multipartItems = new Map<string, DiscoveredItem[]>();
	for (const item of items) {
		const parsed = parseVideoFilename(item.relativePath, typeKey);
		if (!parsed.part) {
			continue;
		}

		const logicalKey = path.posix.join(path.posix.dirname(item.relativePath), parsed.logicalStem)
			.toLocaleLowerCase('en-US');
		multipartItems.set(logicalKey, [...(multipartItems.get(logicalKey) ?? []), item]);
	}

	const absorbedIds = new Set<string>();
	for (const members of multipartItems.values()) {
		members.sort((left, right) =>
			left.parts[0]!.number - right.parts[0]!.number
			|| left.relativePath.localeCompare(right.relativePath));
		const representative = members[0]!;
		const numbers = members.map((item) => item.parts[0]!.number);
		const uniqueNumbers = new Set(numbers);
		const duplicate = uniqueNumbers.size !== numbers.length;
		const maximum = Math.max(...numbers);
		const contiguous = numbers[0] === 1
			&& maximum === uniqueNumbers.size
			&& [...uniqueNumbers].every((number) => number >= 1 && number <= maximum);
		const tooLarge = members.length > 128;
		const status = duplicate || tooLarge
			? 'ambiguous'
			: members.length < 2 || !contiguous
				? 'incomplete'
				: 'complete';
		const allMeasured = members.every((item) => item.durationMilliseconds !== null);
		const parts = members.flatMap((item) => item.parts).sort((left, right) =>
			left.number - right.number || left.relativePath.localeCompare(right.relativePath));
		const logicalSubtitles = new Map<string, MediaSubtitleTrack>();
		for (const track of members.flatMap((item) => item.subtitleTracks)) {
			logicalSubtitles.set(track.id, track);
		}
		const fileSizeBytes = members.reduce(
			(total, item) => total + (typeof item.technicalMetadata.fileSizeBytes === 'number'
				? item.technicalMetadata.fileSizeBytes
				: 0),
			0,
		);

		representative.aliasIds = members.slice(1).map((item) => item.id);
		representative.multipartStatus = status;
		representative.parts = parts;
		representative.subtitleTracks = [...logicalSubtitles.values()];
		representative.durationMilliseconds = status === 'complete' && allMeasured
			? members.reduce((total, item) => total + item.durationMilliseconds!, 0)
			: null;
		representative.probeStatus = status === 'complete' && allMeasured ? 'complete' : 'failed';
		representative.probeErrorCode = status === 'complete'
			? members.find((item) => item.probeErrorCode)?.probeErrorCode ?? null
			: `multipart-${status}`;
		representative.technicalMetadata = {
			...representative.technicalMetadata,
			fileSizeBytes,
			parts: members.map((item) => item.technicalMetadata),
		};
		representative.fingerprint = createHash('sha256')
			.update(members.map((item) => item.fingerprint).join(':'))
			.digest('hex');
		representative.fileModifiedAt = members
			.map((item) => item.fileModifiedAt)
			.sort()
			.at(-1)!;
		for (const member of members.slice(1)) {
			absorbedIds.add(member.id);
		}
		if (status !== 'complete') {
			issues.push({
				path: representative.relativePath,
				code: status === 'ambiguous' ? 'multipart_ambiguous' : 'multipart_incomplete',
				message: status === 'ambiguous'
					? 'Multipart numbering is duplicated or exceeds the 128-part limit.'
					: 'Multipart numbering must contain a contiguous sequence beginning with part 1.',
				severity: 'warning',
			});
		}
	}

	for (let index = items.length - 1; index >= 0; index -= 1) {
		if (absorbedIds.has(items[index]!.id)) {
			items.splice(index, 1);
		}
	}
}
