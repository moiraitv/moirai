/** Expected conflict for a case-insensitive user-visible resource identity. */
export class ResourceIdentityConflictError extends Error {
	constructor(public readonly resourceType: 'library' | 'program' | 'template' | 'channel-number') {
		super(`That ${resourceType === 'channel-number' ? 'channel number' : `${resourceType} name`} is already in use`);
		this.name = 'ResourceIdentityConflictError';
	}
}

/** Expected conflict for an authored identifier already owned by another resource. */
export class SchedulingIdentityConflictError extends Error {
	constructor(public readonly identityType: 'slot' | 'boundary' | 'layer') {
		super(`That ${identityType} identifier is already owned by another schedule`);
		this.name = 'SchedulingIdentityConflictError';
	}
}
