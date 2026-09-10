import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import Layout from './Layout.vue';
import ReviewChanges from './ReviewChanges.vue';
import '../../../web/src/styles/_tokens.scss';
import './theme.scss';
import '../../../web/src/styles/_help-term-badges.scss';

export default {
	extends: DefaultTheme,
	Layout,
	/** Register the comparison widget used by the generated review dashboard. */
	enhanceApp({ app }) {
		app.component('ReviewChanges', ReviewChanges);
	},
} satisfies Theme;
