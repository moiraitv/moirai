import { createRouter, createWebHistory } from 'vue-router';
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

/** Module-level router value for router. */
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
		{ path: '/libraries/:id', component: LibraryPage },
		{ path: '/libraries/:libraryId/items/:id', component: MediaItemPage },
		{ path: '/channels', component: ChannelsPage },
		{ path: '/quick', component: QuickSetupPage },
		{ path: '/schedules', redirect: '/schedules/channels' },
		{ path: '/schedules/templates', component: TemplatesPage },
		{ path: '/schedules/templates/:id', component: TemplatesPage },
		{ path: '/schedules/channels', component: ChannelSchedulesPage },
		{ path: '/schedules/channels/:id', component: ChannelSchedulesPage },
		{ path: '/schedules/programs', component: ProgramsPage },
		{ path: '/schedules/programs/:id', component: ProgramsPage },
		{ path: '/settings', component: SettingsPage },
		{ path: '/account', component: AccountPage },
		{ path: '/logs', component: LogsPage },
	],
});
