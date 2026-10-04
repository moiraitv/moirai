import { describe, expect, it } from 'vitest';
import { subtitleRuleMode } from '@web/subtitle-preferences';
import { loadSubtitleLanguages, resolveSubtitleLanguage, searchSubtitleLanguages, SUBTITLE_LANGUAGE_RESULT_LIMIT } from '@web/subtitle-languages';

describe('subtitle editor rules', () => {
	it('keeps omitted inheritance, explicit clearing, and incomplete specific drafts distinct', () => {
		expect(subtitleRuleMode(undefined, true)).toBe('inherit');
		expect(subtitleRuleMode(undefined, false)).toBe('any');
		expect(subtitleRuleMode(null, true)).toBe('any');
		expect(subtitleRuleMode('', true)).toBe('specific');
		expect(subtitleRuleMode('eng', true)).toBe('specific');
	});

});

describe('subtitle language inventory', () => {
	it('resolves names and selected labels without rewriting saved aliases or unfamiliar codes', async () => {
		const languages = await loadSubtitleLanguages();
		expect(resolveSubtitleLanguage('English', languages)).toBe('en');
		expect(resolveSubtitleLanguage('English (en)', languages)).toBe('en');
		expect(resolveSubtitleLanguage(' ENG ', languages)).toBe('eng');
		expect(resolveSubtitleLanguage('fre', languages)).toBe('fre');
		expect(resolveSubtitleLanguage('qzz', languages)).toBe('qzz');
		expect(resolveSubtitleLanguage('Unknown language name', languages)).toBeNull();
		expect(resolveSubtitleLanguage('', languages)).toBeNull();
	});
	it('requires an explicit choice for colliding names and codes while preserving saved codes', async () => {
		const languages = await loadSubtitleLanguages();
		expect(resolveSubtitleLanguage('Ga', languages)).toBeNull();
		expect(resolveSubtitleLanguage('ga', languages, true)).toBe('ga');
		expect(resolveSubtitleLanguage('Ga (gaa)', languages)).toBe('gaa');
		expect(resolveSubtitleLanguage('Irish (ga)', languages)).toBe('ga');
		expect(searchSubtitleLanguages(languages, 'Ga').slice(0, 2).map(language => language.code)).toEqual(['gaa', 'ga']);
	});
	it('searches aliases and bounds the rendered list using the public limit', async () => {
		const languages = await loadSubtitleLanguages();
		expect(searchSubtitleLanguages(languages, 'English')[0]?.code).toBe('en');
		expect(searchSubtitleLanguages(languages, 'eng')[0]?.code).toBe('en');
		expect(searchSubtitleLanguages(languages, 'eng').some(language => language.code === 'en')).toBe(true);
		expect(searchSubtitleLanguages(languages, 'fre').some(language => language.code === 'fr')).toBe(true);
		expect(searchSubtitleLanguages(languages, '')).toHaveLength(SUBTITLE_LANGUAGE_RESULT_LIMIT);
		expect(searchSubtitleLanguages(languages, 'a').length).toBeLessThanOrEqual(SUBTITLE_LANGUAGE_RESULT_LIMIT);
	});
});
