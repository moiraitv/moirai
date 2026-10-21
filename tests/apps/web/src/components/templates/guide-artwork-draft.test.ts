import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { randomUUID } from 'node:crypto';
import { scheduleSlotSchema } from '@moirai/shared';
import { useGuideArtworkDraft } from '@web/components/templates/guide-artwork-draft';

const upload = vi.hoisted(() => vi.fn());
vi.mock('@web/api', () => ({ api: { uploadGuideArtwork: upload } }));
const scopes: ReturnType<typeof effectScope>[] = [];

afterEach(() => {
	for (const scope of scopes.splice(0)) {
		scope.stop();
	}
	vi.resetAllMocks();
});

it('uploads recovered files again and reuses the new reference for retries in the same editor', async () => {
	const expired = randomUUID();
	const fresh = randomUUID();
	const slot = scheduleSlotSchema.parse({ id: randomUUID(), startSeconds: 0, programId: randomUUID(),
		guide: { mode: 'block', title: 'Recovered block', description: '', boundary: 'scheduled', artworkId: expired } });
	const slots = ref([slot]);
	const scope = effectScope();
	scopes.push(scope);
	const draft = scope.run(() => useGuideArtworkDraft(slots))!;
	const file = new File(['retained-image'], 'guide.png', { type: 'image/png' });
	upload.mockResolvedValue({ artworkId: fresh });

	draft.restore({ [slot.id]: file });
	expect(draft.preview(slot)).toMatch(/^blob:/);
	expect(draft.hasPending.value).toBe(true);
	await draft.upload();
	await draft.upload();
	expect(upload).toHaveBeenCalledExactlyOnceWith(file);
	expect(slots.value[0]!.guide).toMatchObject({ artworkId: fresh });
});

it('retains a recovered file for retry when its fresh upload fails', async () => {
	const slot = scheduleSlotSchema.parse({ id: randomUUID(), startSeconds: 0, programId: randomUUID(),
		guide: { mode: 'block', title: 'Recovered block', description: '', boundary: 'scheduled' } });
	const scope = effectScope();
	scopes.push(scope);
	const draft = scope.run(() => useGuideArtworkDraft(ref([slot])))!;
	const file = new File(['retained-image'], 'guide.png', { type: 'image/png' });
	const fresh = randomUUID();
	upload.mockRejectedValueOnce(new Error('Upload failed')).mockResolvedValueOnce({ artworkId: fresh });

	draft.restore({ [slot.id]: file });
	await expect(draft.upload()).rejects.toThrow('Upload failed');
	expect(draft.files()[slot.id]).toBe(file);
	expect(draft.hasPending.value).toBe(true);
	await draft.upload();
	expect(upload).toHaveBeenCalledTimes(2);
});
