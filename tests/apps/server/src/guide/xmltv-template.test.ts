import { expect, it } from 'vitest';
import { BUILTIN_GUIDE_TEMPLATE } from '@moirai/shared';
import {
	compileGuideTemplate,
	escapeXmlText,
	flattenLiquidPreviewValues,
	validateGuideTemplateSources,
} from '@server/guide/xmltv-template.js';

it('escapes interpolated XML and rejects invalid Liquid on preview validation', async () => {
	expect(escapeXmlText(`A <title> & "quote"`)).toBe('A &lt;title&gt; &amp; &quot;quote&quot;');
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
