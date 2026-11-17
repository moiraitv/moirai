<script setup lang="ts">
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Library } from '@moirai/shared';
import LibraryEditor from '../components/library/LibraryEditor.vue';
import { useLibraryEditorRoute } from '../composables/useLibraryEditorRoute';
import { useLibrariesStore } from '../stores/libraries';
import LibrariesPage from './LibrariesPage.vue';
import LibraryPage from './LibraryPage.vue';

const route = useRoute();
const router = useRouter();
const libraries = useLibrariesStore();
const library = ref<Library>();
const catalog = ref<InstanceType<typeof LibraryPage>>();
const { editor, open, creating, revision, close, adopt } = useLibraryEditorRoute();
watch(() => route.params.id, (id) => {
	if (library.value?.id !== id) {
		library.value = undefined;
	}
}, { flush: 'sync' });

/** Reuse the catalog's authoritative load without requesting the library a second time. */
function loaded(value: Library): void {
	if (value.id === route.params.id) {
		library.value = value;
	}
}

/** Keep the editor open as a new library becomes an editable saved resource. */
async function saved(value: Library): Promise<void> {
	library.value = value;
	if (creating.value) {
		await adopt(value.id);
	}

	catalog.value?.applySettings(value);
	await libraries.load();
}

/** Refresh shared state and leave the deleted library's catalog. */
async function deleted(): Promise<void> {
	await libraries.load();
	await router.push('/libraries');
}
</script>

<template>
	<LibrariesPage v-if="!route.params.id" />
	<LibraryPage v-else ref="catalog" @loaded="loaded" />
	<LibraryEditor v-if="open && (creating || library?.id === route.params.id)" :key="revision" ref="editor" :library="creating ? undefined : library" :existing-libraries="libraries.loaded ? libraries.libraries : undefined" @close="close" @saved="saved" @deleted="deleted" />
</template>
