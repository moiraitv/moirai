import { fileURLToPath, URL } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const webPort = Number(process.env.MOIRAI_WEB_PORT ?? 5173);
const apiTarget = process.env.MOIRAI_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
	plugins: [vue()],
	resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
	server: {
		host: '127.0.0.1',
		port: webPort,
		proxy: { '/api': { target: apiTarget, ws: true } },
	},
});
