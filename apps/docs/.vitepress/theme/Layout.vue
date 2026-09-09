<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import { withBase } from 'vitepress';
import ReviewBanner from './ReviewBanner.vue';
import packageJson from '../../../../package.json';

const { Layout } = DefaultTheme;
</script>

<template>
	<Layout>
		<template #sidebar-nav-before>
			<a class="docs-sidebar-brand" :href="withBase('/')">
				<img :src="withBase('/moirai-logo.png')" alt="Moirai" />
				<strong class="docs-sidebar-title">Moirai {{ packageJson.version }}</strong>
				<span>User Guide</span>
			</a>
		</template>
		<template #doc-before>
			<ReviewBanner />
		</template>
	</Layout>
</template>
