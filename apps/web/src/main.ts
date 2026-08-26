import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { liveEvents } from './live-events';
import { router } from './router';
import './styles/main.scss';

createApp(App).use(createPinia()).use(router).mount('#app');
liveEvents.start();
window.addEventListener('beforeunload', () => liveEvents.stop(), { once: true });
