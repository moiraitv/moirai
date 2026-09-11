import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Complete authored screenshot inventory; partial captures must never be published. */
export const screenshotNames = [
	'account.png',
	'administrator-setup.png',
	'channel-editor-audio.png',
	'channel-editor-fallback.png',
	'channel-editor-logo.png',
	'channel-editor-video.png',
	'channel-editor-encoding.png',
	'channel-editor-subtitles.png',
	'channel-editor.png',
	'channel-schedule-boundaries.png',
	'channel-schedule-conditional.png',
	'channel-schedule-predicates.png',
	'channel-schedules.png',
	'channels.png',
	'credit-template-editor.png',
	'credit-templates.png',
	'credit-template-view.png',
	'encoding-profile-editor.png',
	'encoding-profile-view.png',
	'encoding-presets.png',
	'dashboard.png',
	'guide.png',
	'guide-single-block.png',
	'libraries.png',
	'library-catalog.png',
	'library-filters.png',
	'library-offline.png',
	'logs.png',
	'media-item.png',
	'program-content-create.png',
	'program-sequence-create.png',
	'program-subtitles.png',
	'programs.png',
	'quick-setup.png',
	'settings.png',
	'template-editor.png',
	'template-preview.png',
	'template-slot-boundary.png',
	'template-slot-filler.png',
	'template-slot-playback.png',
	'template-slot-guide.png',
	'templates.png',
] as const;

/** Validate the entire stage before replacing any checked-in screenshot. */
export async function publishScreenshots(stage: string, destination: string): Promise<void> {
	const files = await Promise.all(screenshotNames.map(async (name) => ({ name, bytes: await readFile(path.join(stage, name)) })));
	for (const { name, bytes } of files) {
		await writeFile(path.join(destination, name), bytes);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await publishScreenshots(path.resolve('test-results/docs-screenshots'), path.resolve('apps/docs/src/public/screenshots'));
}
