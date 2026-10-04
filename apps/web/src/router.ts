import FillerPresetsPage from './views/FillerPresetsPage.vue';
import EncodingProfilesPage from './views/EncodingProfilesPage.vue';
import { createRouter, createWebHistory } from 'vue-router';
import CreditTemplatesPage from './views/CreditTemplatesPage.vue';
import GuideTemplatesPage from './views/GuideTemplatesPage.vue';
import DashboardPage from './views/DashboardPage.vue';
import LibrariesPage from './views/LibrariesPage.vue';
import LibraryPage from './views/LibraryPage.vue';
import ChannelsPage from './views/ChannelsPage.vue';
import SettingsPage from './views/SettingsPage.vue';
import MediaItemPage from './views/MediaItemPage.vue';
import ProgramsPage from './views/ProgramsPage.vue';
import TemplatesPage from './views/TemplatesPage.vue';
import ChannelSchedulesPage from './views/ChannelSchedulesPage.vue';
import GuidePage from './views/GuidePage.vue';
import LogsPage from './views/LogsPage.vue';
import AuthenticationPage from './views/AuthenticationPage.vue';
import AccountPage from './views/AccountPage.vue';
import QuickSetupPage from './views/QuickSetupPage.vue';
import NotFoundPage from './views/NotFoundPage.vue';

/** Management routes retain resource identity and collection controls in browser history. */
export const router = createRouter({
	history: createWebHistory(),
	routes: [
		{ path: '/login', component: AuthenticationPage, meta: { publicAuthentication: true } },
		{ path: '/setup', component: AuthenticationPage, meta: { publicAuthentication: true } },
		{
			path: '/recover',
			component: AuthenticationPage,
			meta: { publicAuthentication: true, allowAuthenticated: true },
		},
		{ path: '/', component: DashboardPage },
		{ path: '/guide', component: GuidePage },
		{ path: '/libraries', component: LibrariesPage },
		{ path: '/libraries/new', component: LibrariesPage },
		{ path: '/libraries/:id', component: LibraryPage },
		{ path: '/libraries/:id/settings', component: LibraryPage },
		{ path: '/libraries/:libraryId/items/:id', component: MediaItemPage },
		{ path: '/channels', component: ChannelsPage },
		{ path: '/channels/:id', component: ChannelsPage },
		{ path: '/quick', component: QuickSetupPage },
		{ path: '/schedules', redirect: '/schedules/channels' },
		{ path: '/schedules/mid-roll-presets', redirect: '/filler/mid-rolls' },
		{ path: '/filler', redirect: '/filler/pre-rolls' },
		...(['pre-roll', 'mid-roll', 'post-roll', 'tail'] as const).flatMap(kind => ['', '/:id'].map(suffix => ({ path: `/filler/${kind === 'tail' ? 'tail-fillers' : `${kind}s`}${suffix}`, component: FillerPresetsPage, props: { kind }, meta: { fillerKind: kind } }))),
		{ path: '/schedules/templates', component: TemplatesPage },
		{ path: '/schedules/templates/:id', component: TemplatesPage },
		{ path: '/schedules/channels', component: ChannelSchedulesPage },
		{ path: '/schedules/channels/:id', component: ChannelSchedulesPage },
		{ path: '/playback', redirect: '/playback/encoding-profiles' },
		{ path: '/playback/credit-templates', component: CreditTemplatesPage },
		{ path: '/playback/credit-templates/:id', component: CreditTemplatesPage },
		{ path: '/playback/guide-templates', component: GuideTemplatesPage },
		{ path: '/playback/guide-templates/:id', component: GuideTemplatesPage },
		{ path: '/playback/encoding-profiles', component: EncodingProfilesPage },
		{ path: '/playback/encoding-profiles/:id', component: EncodingProfilesPage },
		{ path: '/schedules/programs', component: ProgramsPage },
		{ path: '/schedules/programs/:id', component: ProgramsPage },
		{ path: '/settings', component: SettingsPage },
		{ path: '/account', component: AccountPage },
		{ path: '/logs', component: LogsPage },
		{ path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundPage },
	],
});

/** Preserve older channel editor bookmarks while replacing their query-based identity. */
router.beforeEach(to => {
	if (to.path !== '/channels' || (to.query.new !== '1' && typeof to.query.edit !== 'string')) {
		return;
	}
	const query = { ...to.query };
	const id = query.new === '1' ? 'new' : String(query.edit);
	delete query.new;
	delete query.edit;
	return { path: `/channels/${encodeURIComponent(id)}`, query, replace: true };
});
