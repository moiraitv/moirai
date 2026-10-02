import type { Repository } from './index.js';

/** Focused repository domains whose transactions may execute in the writer. */
export type WriteDomains = {
	root: Repository;
	preferences: Repository['semantic']['preferences'];
} & Pick<Repository, 'authentication' | 'encodingProfiles' | 'creditTemplates' | 'guideTemplates' | 'semantic'>;

/** Runtime mutations accepted by the single writer; reads remain on separate connections. */
export const WRITE_METHODS = {
	root: ['setMediaIssueIgnored', 'setSilentEndingAcceptance', 'createLibrary', 'updateLibrary', 'stageLibrarySourceChange', 'deleteLibrary', 'setWatcherStatus', 'markChangeDetected', 'recoverInterruptedScans', 'beginScan', 'reconcileScan', 'applyMissingItemPresence', 'confirmLibraryRemovals', 'authorizeSourceAcceptance', 'cancelSourceChange', 'failScan', 'cancelScan', 'pruneScanHistory', 'createChannel', 'updateChannel', 'updateChannelLogo', 'deleteChannel', 'createQuickChannelSetup', 'createProgram', 'updateProgram', 'appendProgramItems', 'appendProgramGroups', 'deleteProgram', 'createScheduleTemplate', 'updateScheduleTemplate', 'deleteScheduleTemplate', 'setChannelSchedule', 'resetChannelScheduleState', 'deleteChannelSchedule', 'setTemplateAssignments', 'markTimelinePending', 'markTimelineFailed', 'commitMaterializedTimeline', 'setPlaybackSettings', 'recordViewingPreference', 'clearViewingPreferences', 'pruneViewingPreferences'],
	authentication: ['claimInitialLocalIdentity', 'replaceLocalIdentityAndSession', 'createLogtoSessionIfLogoutGenerationCurrent', 'createSessionIfLocalPasswordCurrent', 'touchSession', 'deleteSession', 'revokeLogtoSessionsForConfiguration', 'applyLogtoLogout', 'createOidcTransaction', 'consumeOidcTransaction', 'createRecoveryToken', 'consumeRecoveryToken', 'prune'],
	encodingProfiles: ['save', 'setDefault', 'delete'],
	creditTemplates: ['save', 'delete'],
	guideTemplates: ['save', 'setDefault', 'delete'],
	semantic: ['reconcile', 'retryFailed', 'store', 'storeBatch', 'preparationError', 'pruneSeeds', 'commitSeeds'],
	preferences: ['catalog', 'retryFailed', 'reconcile', 'preparationError', 'store'],
} as const satisfies { [D in keyof WriteDomains]: readonly Extract<keyof WriteDomains[D], string>[] };

/** Method arguments are derived from the owning repository instead of duplicating contracts. */
export type WriteCommand = {
	[D in keyof WriteDomains]: {
		[M in typeof WRITE_METHODS[D][number]]: M extends keyof WriteDomains[D] ? WriteDomains[D][M] extends (...args: infer A) => unknown
			? { domain: D; method: M; args: A } : never : never;
	}[typeof WRITE_METHODS[D][number]];
}[keyof WriteDomains];

/** Preserve each repository command's result type after its asynchronous acknowledgement. */
export type WriteResult<C extends WriteCommand> = C extends WriteCommand ? WriteDomains[C['domain']][C['method'] & keyof WriteDomains[C['domain']]] extends (...args: never[]) => infer R ? Awaited<R> : never : never;

/** Resolve a command owner without exposing private persistence domains. */
export function writeDomain(repository: Repository, domain: keyof WriteDomains): WriteDomains[keyof WriteDomains] {
	return domain === 'root' ? repository : domain === 'preferences' ? repository.semantic.preferences : repository[domain];
}

/** Execute one trusted command after checking the explicit mutation allowlist. */
export async function executeWrite(repository: Repository, command: WriteCommand): Promise<unknown> {
	if (!(WRITE_METHODS[command.domain] as readonly string[]).includes(command.method)) {
		throw new Error('Unknown database write command');
	}
	const owner = writeDomain(repository, command.domain);
	const method = Reflect.get(owner, command.method) as (...args: unknown[]) => unknown;
	return await method.apply(owner, command.args);
}
