import type {
	ApiErrorBody,
	AppCapabilities,
	Channel,
	ChannelCreate,
	PlaybackEngineStatus,
	PlaybackSettings,
	Library,
	LibraryCreate,
	LibraryReconciliation,
	ReconciliationAction,
	GenreMatch,
	MediaBrowseResult,
	MediaGenreFacet,
	MediaGroup,
	MediaItem,
	MediaItemDetail,
	MediaSort,
	MediaSourcePickerResult,
	ProgramCreate,
	ProgramUpdate,
	ScheduleGuide,
	GuideSegmentDetail,
	ScheduleTemplate,
	ScheduleTemplateCreate,
	ScheduleTemplateUpdate,
	SchedulingOverview,
	SchedulingProgram,
	ScanRun,
	ChannelSchedule,
	ChannelTimelineMaterializationStatus,
	ChannelScheduleDraftPreview,
	ChannelScheduleConfig,
	TimelineDraftPreview,
	TimelinePreview,
	LogFile,
	LogLevel,
	LogPage,
	DataConflictReport,
} from '@moirai/shared';
import type {
	HardwareAccelerationPrediction,
	HardwareAccelerationPredictionRequest,
} from '@moirai/shared/api-contracts';

/** Catalog filters and paging encoded into a media browse request. */
export interface MediaQuery {
	parentId?: string | undefined;
	page: number;
	pageSize: number;
	sort: MediaSort;
	direction: 'asc' | 'desc';
	name?: string | undefined;
	releaseYearFrom?: number | undefined;
	releaseYearTo?: number | undefined;
	addedFrom?: string | undefined;
	addedBefore?: string | undefined;
	genres?: string[] | undefined;
	genreMatch?: GenreMatch | undefined;
	actor?: string | undefined;
	director?: string | undefined;
}

/** Search and paging controls for a program source picker. */
export interface MediaSourcePickerQuery {
	target: 'items' | 'groups';
	parentId?: string | undefined;
	page: number;
	pageSize: number;
	search?: string | undefined;
}

/** Cursor, severity, and search filters for operational logs. */
export interface LogQuery {
	cursor?: string | undefined;
	level?: LogLevel | undefined;
	search?: string | undefined;
	limit?: number | undefined;
}

/** Preserve a failed API response status and its safe public message. */
export class ApiError extends Error {
	constructor(
		public readonly body: ApiErrorBody,
		public readonly status: number,
	) {
		super(body.message);
	}
}

/** Send an API request and parse its JSON response or throw a typed API error. */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: { 'Content-Type': 'application/json', ...init?.headers },
	});
	if (!response.ok) {
		throw new ApiError((await response.json()) as ApiErrorBody, response.status);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return response.json() as Promise<T>;
}

/** Upload a managed channel logo and return its internal URI. */
async function uploadChannelLogo(id: string, image: Blob): Promise<Channel> {
	const response = await fetch(`/api/v1/channels/${id}/logo`, {
		method: 'PUT',
		headers: { 'Content-Type': 'image/png' },
		body: image,
	});
	if (!response.ok) {
		throw new ApiError((await response.json()) as ApiErrorBody, response.status);
	}

	return response.json() as Promise<Channel>;
}

/** Module-level api value for api. */
export const api = {
	capabilities: () => request<AppCapabilities>('/api/v1/capabilities'),
	dataConflicts: () => request<DataConflictReport>('/api/v1/status/conflicts'),
	logs: (query: LogQuery = {}) => {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== '') {
				params.set(key, String(value));
			}
		}
		return request<LogPage>(`/api/v1/logs?${params}`);
	},
	logFiles: () => request<LogFile[]>('/api/v1/logs/files'),
	libraries: () => request<Library[]>('/api/v1/libraries'),
	library: (id: string) => request<Library>(`/api/v1/libraries/${id}`),
	createLibrary: (body: LibraryCreate) =>
		request<Library>('/api/v1/libraries', { method: 'POST', body: JSON.stringify(body) }),
	deleteLibrary: (id: string) => request<void>(`/api/v1/libraries/${id}`, { method: 'DELETE' }),
	scanLibrary: (id: string) =>
		request<{ status: string }>(`/api/v1/libraries/${id}/scans`, { method: 'POST' }),
	cancelLibraryScan: (id: string) =>
		request<void | { status: string }>(`/api/v1/libraries/${id}/scans/current`, {
			method: 'DELETE',
		}),
	scans: (id: string) => request<ScanRun[]>(`/api/v1/libraries/${id}/scans`),
	libraryReconciliation: (id: string) =>
		request<LibraryReconciliation>(`/api/v1/libraries/${id}/reconciliation`),
	reconcileLibrary: (id: string, body: ReconciliationAction) =>
		request<LibraryReconciliation | { status: string }>(`/api/v1/libraries/${id}/reconciliation`, {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	media: (id: string, query: MediaQuery) => {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
				continue;
			}

			if (Array.isArray(value)) {
				for (const entry of value) {
					params.append(key, String(entry));
				}
			}
			else {
				params.set(key, String(value));
			}
		}
		return request<MediaBrowseResult>(`/api/v1/libraries/${id}/media?${params}`);
	},
	mediaGenres: (id: string) => request<MediaGenreFacet[]>(`/api/v1/libraries/${id}/media-genres`),
	mediaSourceOptions: (id: string, query: MediaSourcePickerQuery) => {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== '') {
				params.set(key, String(value));
			}
		}
		return request<MediaSourcePickerResult>(
			`/api/v1/libraries/${id}/media-source-options?${params}`,
		);
	},
	mediaSelection: (id: string, itemIds: string[]) =>
		request<MediaItem[]>(`/api/v1/libraries/${id}/media-selection`, {
			method: 'POST',
			body: JSON.stringify({ itemIds }),
		}),
	mediaGroupSelection: (id: string, groupIds: string[]) =>
		request<MediaGroup[]>(`/api/v1/libraries/${id}/media-group-selection`, {
			method: 'POST',
			body: JSON.stringify({ groupIds }),
		}),
	mediaItem: (id: string) => request<MediaItemDetail>(`/api/v1/media/${id}`),
	channels: () => request<Channel[]>('/api/v1/channels'),
	createChannel: (body: ChannelCreate) =>
		request<Channel>('/api/v1/channels', { method: 'POST', body: JSON.stringify(body) }),
	updateChannel: (id: string, body: ChannelCreate) =>
		request<Channel>(`/api/v1/channels/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
	deleteChannel: (id: string) => request<void>(`/api/v1/channels/${id}`, { method: 'DELETE' }),
	uploadChannelLogo,
	deleteChannelLogo: (id: string) =>
		request<Channel>(`/api/v1/channels/${id}/logo`, { method: 'DELETE' }),
	schedulingOverview: () => request<SchedulingOverview>('/api/v1/scheduling/overview'),
	createProgram: (body: ProgramCreate) =>
		request<SchedulingProgram>('/api/v1/programs', {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	updateProgram: (id: string, body: ProgramUpdate) =>
		request<SchedulingProgram>(`/api/v1/programs/${id}`, {
			method: 'PATCH',
			body: JSON.stringify(body),
		}),
	deleteProgram: (id: string) => request<void>(`/api/v1/programs/${id}`, { method: 'DELETE' }),
	createScheduleTemplate: (body: ScheduleTemplateCreate) =>
		request<ScheduleTemplate>('/api/v1/schedule-templates', {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	updateScheduleTemplate: (id: string, body: ScheduleTemplateUpdate) =>
		request<ScheduleTemplate>(`/api/v1/schedule-templates/${id}`, {
			method: 'PATCH',
			body: JSON.stringify(body),
		}),
	deleteScheduleTemplate: (id: string) =>
		request<void>(`/api/v1/schedule-templates/${id}`, { method: 'DELETE' }),
	setTemplateAssignments: (id: string, channelIds: string[]) =>
		request<ChannelSchedule[]>(`/api/v1/schedule-templates/${id}/assignments`, {
			method: 'PUT',
			body: JSON.stringify({ channelIds }),
		}),
	setChannelSchedule: (id: string, body: ChannelScheduleConfig) =>
		request<ChannelSchedule>(`/api/v1/channels/${id}/schedule`, {
			method: 'PUT',
			body: JSON.stringify(body),
		}),
	deleteChannelSchedule: (id: string) =>
		request<void>(`/api/v1/channels/${id}/schedule`, { method: 'DELETE' }),
	draftTimelinePreview: (body: TimelineDraftPreview) =>
		request<TimelinePreview>('/api/v1/timeline-preview', {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	draftChannelSchedulePreview: (body: ChannelScheduleDraftPreview) =>
		request<TimelinePreview>('/api/v1/channel-schedule-preview', {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	scheduleGuide: (startDate: string, days = 7) =>
		request<ScheduleGuide>(
			`/api/v1/schedule-guide?${new URLSearchParams({ startDate, days: String(days) })}`,
		),
	guideSegment: (channelId: string, segmentId: string) =>
		request<GuideSegmentDetail>(
			`/api/v1/channels/${channelId}/guide-segments/${segmentId}`,
		),
	timelineMaterializations: () =>
		request<ChannelTimelineMaterializationStatus[]>('/api/v1/scheduling/materializations'),
	applyChannelTimelineNow: (id: string) =>
		request<ChannelTimelineMaterializationStatus>(
			`/api/v1/channels/${id}/materialization/apply-now`,
			{ method: 'POST' },
		),
	playbackStatus: () => request<PlaybackEngineStatus>('/api/v1/playback/status'),
	predictHardwareAcceleration: (body: HardwareAccelerationPredictionRequest) =>
		request<HardwareAccelerationPrediction>('/api/v1/playback/hardware-acceleration/predict', {
			method: 'POST',
			body: JSON.stringify(body),
		}),
	playbackSettings: () => request<PlaybackSettings>('/api/v1/playback/settings'),
	savePlaybackSettings: (body: PlaybackSettings) =>
		request<PlaybackSettings>('/api/v1/playback/settings', {
			method: 'PUT',
			body: JSON.stringify(body),
		}),
	restartPlaybackChannel: (id: string) =>
		request<void>(`/api/v1/playback/channels/${id}/restart`, { method: 'POST' }),
};
