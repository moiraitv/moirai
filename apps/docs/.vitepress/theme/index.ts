import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import Layout from './Layout.vue';
import '../../../web/src/styles/_tokens.scss';
import './theme.scss';

export default {
	extends: DefaultTheme,
	Layout,
} satisfies Theme;
