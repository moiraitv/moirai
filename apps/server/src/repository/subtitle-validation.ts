import { eq } from 'drizzle-orm';
import type { SubtitlePreferences } from '@moirai/shared';
import type { MoiraiDatabase } from '../db/index.js';
import { creditTemplates } from '../db/schema.js';
import { CreditTemplateError } from './credit-templates.js';

/** Validate only actual credit references; normal resource writes do not add this query. */
export function validateCreditReference(db: MoiraiDatabase, preferences?: SubtitlePreferences): void {
	const id = preferences?.creditsTemplateId;
	if (id && !db.select({ id: creditTemplates.id }).from(creditTemplates).where(eq(creditTemplates.id, id)).get()) {
		throw new CreditTemplateError('Selected credit template does not exist', 400);
	}
}

