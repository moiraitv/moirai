import { expect, it } from 'vitest';
import { BUILTIN_GUIDE_TEMPLATE } from '@moirai/shared';
import {
	compileGuideTemplate,
	escapeXmlText,
	flattenLiquidPreviewValues,
	guideTimestampFormatter,
	renderProgrammeFragment,
	validateGuideTemplateSources,
} from '@server/guide/xmltv-template.js';

it('preserves distinct local offsets across the repeated hour in guide presentation', () => {
	const format = guideTimestampFormatter('America/Los_Angeles');
	expect(format('2026-11-01T08:30:00Z')).toBe('20261101013000 -0700');
	expect(format('2026-11-01T09:30:00Z')).toBe('20261101013000 -0800');
	expect(format('2026-11-01T08:30:00Z')).toBe('20261101013000 -0700');
});

it('escapes interpolated XML and rejects invalid Liquid on preview validation', async () => {
	expect(escapeXmlText('A <title> & "quote"')).toBe('A &lt;title&gt; &amp; &quot;quote&quot;');
	await expect(validateGuideTemplateSources({
		...BUILTIN_GUIDE_TEMPLATE.sources,
		episode: '{{ missing }}',
	})).rejects.toThrow();
	await expect(validateGuideTemplateSources({
		...BUILTIN_GUIDE_TEMPLATE.sources,
		episode: '{% invalid %}',
	})).rejects.toThrow();
	await expect(validateGuideTemplateSources({
		...BUILTIN_GUIDE_TEMPLATE.sources,
		channel: '<channel id="{{ kind }}"></channel>',
	})).rejects.toThrow();
	await expect(validateGuideTemplateSources(BUILTIN_GUIDE_TEMPLATE.sources)).resolves.toBeUndefined();
	expect(() => compileGuideTemplate({
		...BUILTIN_GUIDE_TEMPLATE.sources,
		channel: '{% include "secret" %}',
	}, { fallback: false })).toThrow(/File-loading template tags are disabled/u);
	expect(flattenLiquidPreviewValues({
		kind: 'episode',
		item: { kind: 'episode', title: 'Pilot', show_title: 'Example Show', plot: null, genre_names: ['Drama'] },
	})).toEqual(expect.arrayContaining([
		{ name: 'kind', value: 'episode' },
		{ name: 'item.kind', value: 'episode' },
		{ name: 'item.title', value: 'Pilot' },
		{ name: 'item.show_title', value: 'Example Show' },
		{ name: 'item.plot', value: 'null' },
		{ name: 'item.genre_names', value: 'Drama' },
	]));
});


it('stops a guide fragment when its playout deadline changes during rendering', async () => {
	const sources = { ...BUILTIN_GUIDE_TEMPLATE.sources,
		other: '<programme>{% for value in (1..20) %}<title>{{ value }}</title>{% endfor %}</programme>' };
	const compiled = compileGuideTemplate(sources, { fallback: false });
	let checks = 0;
	await expect(renderProgrammeFragment(compiled, 'other', {}, {
		fallback: true, remainingMs: () => ++checks < 5 ? 2000 : 0,
	})).rejects.toThrow(/guide label preparation deadline reached/i);
});
