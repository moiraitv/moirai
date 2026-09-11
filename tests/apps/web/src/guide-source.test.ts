import { expect, it } from 'vitest';
import { guideSourceLabel } from '../../../../apps/web/src/guide-source';

it('shows the source name for primary content and keeps filler and gaps distinct', () => {
	const names = { music: 'Rock Collection' };
	expect(guideSourceLabel({ role: 'primary', programId: 'music' }, names)).toBe('Rock Collection');
	expect(guideSourceLabel({ role: 'filler', programId: 'music' }, names)).toBe('Filler');
	expect(guideSourceLabel({ role: 'dead-air', programId: 'music' }, names)).toBe('Gap');
	expect(guideSourceLabel({ role: 'primary', programId: 'deleted' }, names)).toBe('Missing program');
	expect(guideSourceLabel({ role: 'primary', programId: null }, names)).toBe('Scheduled content');
});
