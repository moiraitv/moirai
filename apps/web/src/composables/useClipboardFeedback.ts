import { ref } from 'vue';

/** Copy feedback keeps successful actions transient and failures visible until retry. */
export function useClipboardFeedback() {
	const message = ref('');
	const error = ref('');

	/** Copy text with a selection fallback and retain actionable failures in context. */
	async function copy(value: string, label: string): Promise<void> {
		message.value = '';
		error.value = '';
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(value);
			}
			else {
				const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
				const owner = focused?.closest('[role="dialog"]') ?? document.body;
				const input = document.createElement('textarea');
				input.value = value;
				input.style.position = 'fixed';
				input.style.opacity = '0';
				owner.append(input);
				try {
					input.select();
					if (!document.execCommand('copy')) {
						throw new Error('Copy command was rejected');
					}
				}
				finally {
					input.remove();
					focused?.focus();
				}
			}
			message.value = `${label} copied`;
		}
		catch {
			error.value = `Unable to copy ${label.toLowerCase()}. Try again or select the text to copy it manually.`;
		}
	}

	return { message, error, copy };
}
