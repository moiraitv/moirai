import { mkdir, writeFile } from 'node:fs/promises';
import type { TestInfo } from '@playwright/test';

/** Persist measurements even when the list reporter does not save in-memory attachments. */
export async function saveProfile(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
	await mkdir(testInfo.outputDir, { recursive: true });
	const path = testInfo.outputPath(`${name}.json`);
	await writeFile(path, JSON.stringify(value, null, 2));
	await testInfo.attach(name, { path, contentType: 'application/json' });
}
