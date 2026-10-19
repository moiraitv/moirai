import path from 'node:path';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { readJson } from './files.js';

/** Keep the failed operation so unrelated successes cannot hide an unresolved warning. */
export const backupWarningSchema = z.object({
	message: z.string(),
	kind: z.enum(['upgrade', 'upgrade-cleanup', 'automatic', 'automatic-cleanup', 'storage']).optional(),
}).transform(warning => ({ ...warning, kind: warning.kind ?? legacyWarningKind(warning.message) }));
/** One persisted backup warning, including the operation whose success resolves it. */
export type BackupWarning = z.infer<typeof backupWarningSchema>;

/** Clear a persisted warning only after the relevant operation succeeds, or on explicit dismissal. */
export async function clearBackupWarning(dataDir: string, kinds?: BackupWarning['kind'][]): Promise<void> {
	const filename = path.join(dataDir, 'backup-warning.json');
	if (kinds) {
		const warning = await readJson(filename, backupWarningSchema);
		if (!warning || !kinds.includes(warning.kind)) {
			return;
		}
	}
	await rm(filename, { force: true });
}

/** Recover the operation for warning files written before structured categories were persisted. */
function legacyWarningKind(message: string): 'upgrade' | 'upgrade-cleanup' | 'automatic' | 'automatic-cleanup' | 'storage' {
	if (message.startsWith('The scheduled backup')) {
		return 'automatic';
	}
	if (message.startsWith('Backup settings were saved')) {
		return 'automatic-cleanup';
	}
	if (message.startsWith('Backup storage or schedule')) {
		return 'storage';
	}
	return message.startsWith('Upgrade recovery cleanup failed.') ? 'upgrade-cleanup' : 'upgrade';
}
