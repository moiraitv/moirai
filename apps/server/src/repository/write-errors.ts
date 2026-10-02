import { ZodError, type core } from 'zod';
import { CreditTemplateError } from './credit-templates.js';
import { EncodingProfileError } from './encoding-profiles.js';
import { GuideTemplateError } from './guide-templates.js';
import { ResourceIdentityConflictError, SchedulingIdentityConflictError } from './resource-identity.js';
import { StaleSemanticDecisionError } from './semantic.js';
import { SchedulingValidationError } from '../scheduling/validation.js';

/** Bounded domain error facts transported without stack traces or command contents. */
export interface WriteError {
	name: string;
	message: string;
	statusCode?: number;
	code?: string;
	expose?: boolean;
	resourceType?: string;
	identityType?: string;
	issues?: core.$ZodIssue[];
}

/** Preserve established error identity and public status mapping across the thread boundary. */
export function writeError(payload: WriteError): Error {
	if (payload.name === 'ZodError') {
		return new ZodError(payload.issues ?? []);
	}
	const prototypes: Record<string, object> = {
		CreditTemplateError: CreditTemplateError.prototype,
		EncodingProfileError: EncodingProfileError.prototype,
		GuideTemplateError: GuideTemplateError.prototype,
		ResourceIdentityConflictError: ResourceIdentityConflictError.prototype,
		SchedulingIdentityConflictError: SchedulingIdentityConflictError.prototype,
		StaleSemanticDecisionError: StaleSemanticDecisionError.prototype,
		SchedulingValidationError: SchedulingValidationError.prototype,
	};
	const error = Object.assign(new Error(payload.message), payload);
	const prototype = prototypes[payload.name];
	if (prototype) {
		Object.setPrototypeOf(error, prototype);
	}
	return error;
}
