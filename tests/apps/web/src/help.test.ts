import { beforeEach, describe, expect, it } from 'vitest';
import {
	activeHelpTopic,
	closeHelp,
	helpTopicForPath,
	openHelp,
} from '@web/help.js';

describe('contextual help topics', () => {
	beforeEach(() => closeHelp());

	it('maps management routes to the most specific stable topic', () => {
		expect(helpTopicForPath('/')).toBe('operations.status');
		expect(helpTopicForPath('/quick')).toBe('getting-started.first-channel');
		expect(helpTopicForPath('/libraries/library-id/items/item-id')).toBe('libraries.browse');
		expect(helpTopicForPath('/schedules/programs')).toBe('scheduling.programs');
		expect(helpTopicForPath('/schedules/templates')).toBe('scheduling.templates');
		expect(helpTopicForPath('/schedules/channels/channel-id')).toBe(
			'scheduling.channel-schedules',
		);
		expect(helpTopicForPath('/unknown')).toBe('welcome');
	});

	it('opens and closes a requested topic', () => {
		openHelp('scheduling.programs');
		expect(activeHelpTopic.value).toBe('scheduling.programs');
		closeHelp();
		expect(activeHelpTopic.value).toBeNull();
	});
});
