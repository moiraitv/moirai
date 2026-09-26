/** Minimal indexed video facts shared by probing and playback preparation. */
export interface IndexedVideoStream {
	index: number;
	type: string;
	isAttachedPicture?: boolean | undefined;
}

/** Match the worker's lowest-index ordering while excluding embedded cover artwork. */
export function primaryVideoStream<T extends IndexedVideoStream>(streams: readonly T[]): T | null {
	return streams.reduce<T | null>((selected, stream) => stream.type === 'video'
		&& !stream.isAttachedPicture && (selected === null || stream.index < selected.index)
		? stream : selected, null);
}
