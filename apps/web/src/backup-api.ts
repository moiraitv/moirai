import type { BackupInfo, BackupReview, BackupSettings, BackupStatus } from '@moirai/shared';
import { request } from './api';

/** Authenticated backup requests share the application's CSRF and session-expiry handling. */
export const backupApi = {
	dismissWarning: () => request<void>('/api/v1/backups/warning', { method: 'DELETE' }),
	status: () => request<BackupStatus>('/api/v1/backups'),
	save: (settings: BackupSettings) => request<BackupSettings>('/api/v1/backups/settings', { method: 'PUT', body: JSON.stringify(settings) }),
	create: () => request<BackupInfo>('/api/v1/backups', { method: 'POST' }),
	delete: (id: string) => request<void>(`/api/v1/backups/${id}`, { method: 'DELETE' }),
	review: (id: string) => request<BackupReview>(`/api/v1/backups/${id}/review`, { method: 'POST' }),
	import: (file: File) => {
		const body = new FormData();
		body.append('file', file);
		return request<BackupReview>('/api/v1/backups/import', { method: 'POST', body });
	},
	restore: (id: string) => request<void>(`/api/v1/backups/reviews/${id}/restore`, { method: 'POST' }, async () => undefined),
};
