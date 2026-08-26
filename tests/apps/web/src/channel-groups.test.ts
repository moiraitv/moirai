import { describe, expect, it } from 'vitest';
import { channelCreateSchema, type Channel } from '@moirai/shared';
import { channelGuideRows } from '@web/channel-groups';

function channel(number: string): Channel {
	return {
		...channelCreateSchema.parse({ number, name: `Channel ${number}` }),
		id: `00000000-0000-4000-8000-${number.replaceAll('.', '').padStart(12, '0')}`,
		createdAt: '2026-08-22T00:00:00.000Z',
		updatedAt: '2026-08-22T00:00:00.000Z',
	};
}

describe('channel family rows', () => {
	it('groups repeated dotted prefixes while retaining numeric channel order', () => {
		const rows = channelGuideRows([
			channel('101.1'),
			channel('100.3'),
			channel('9'),
			channel('100.1'),
		]);
		expect(rows.map((row) => (row.type === 'family' ? row.label : row.channel.number))).toEqual([
			'9',
			'100 channels',
			'100.1',
			'100.3',
			'101.1',
		]);
	});
});
