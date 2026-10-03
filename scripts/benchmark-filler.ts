import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Temporal } from '@js-temporal/polyfill';
import { openReadOnlyDatabase } from '../apps/server/src/db/read-only.js';
import { Repository } from '../apps/server/src/repository/index.js';
import type { TimelineCommit } from '../apps/server/src/repository/contracts.js';
import { TimelineMaterializer } from '../apps/server/src/scheduling/timeline-materializer.js';
import { stableJson } from '../apps/server/src/stable-json.js';

/** Remove wall-clock bookkeeping while retaining all scheduling decisions in the output digest. */
function schedulingDecisions(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(schedulingDecisions);
	}
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value)
			.filter(([key]) => !['createdAt', 'updatedAt', 'committedAt', 'generatedAt'].includes(key))
			.map(([key, entry]) => [key, schedulingDecisions(entry)]));
	}
	return value;
}

/** Measure one channel without migrations, persistence, or printing media and authentication data. */
async function benchmark(databasePath: string, channelNumber: string, guideDays: number, timeZone: string, allChannels = false): Promise<void> {
	const database = openReadOnlyDatabase(databasePath);
	try {
		const repository = new Repository(database.db, true);
		const phases: Record<string, number> = {};
		const catalog = repository.getSchedulingCatalog.bind(repository);
		repository.getSchedulingCatalog = async (...args) => {
			const started = performance.now();
			const result = await catalog(...args);
			phases.catalogMs = Math.round(performance.now() - started);
			return result;
		};
		const occupancy = repository.listOccupiedMediaIntervals.bind(repository);
		repository.listOccupiedMediaIntervals = async (...args) => {
			const started = performance.now();
			const result = await occupancy(...args);
			phases.occupancyMs = Math.round(performance.now() - started);
			return result;
		};
		const channels = await repository.listChannels();
		const channel = channels.find(entry => entry.number === channelNumber);
		if (!channel) {
			throw new Error('Benchmark channel not found');
		}
		const schedules = await repository.listChannelSchedules();
		const schedule = schedules.find(entry => entry.channelId === channel.id);
		if (!schedule) {
			throw new Error('Benchmark channel has no schedule');
		}
		// Keep other-channel committed occupancy, but generate only the requested channel.
		if (!allChannels) {
			repository.listChannelSchedules = async () => [schedule];
		}
		const commits: TimelineCommit[] = [];
		let commit: TimelineCommit | null = null;
		const materializer = new TimelineMaterializer(repository, { publish: () => undefined }, timeZone, undefined, async write => {
			if (write.kind === 'failed') {
				throw new Error('Benchmark generation failed');
			}
			if (write.kind === 'commit') {
				commit = write.input;
				commits.push(write.input);
			}
		}, guideDays);
		const started = performance.now();
		await materializer.runNow();
		const elapsedMs = Math.round(performance.now() - started);
		const result = commit as TimelineCommit | null;
		if (!result) {
			throw new Error('No generation needed; use a channel without committed coverage at the benchmark clock');
		}
		console.log(JSON.stringify({ clock: Temporal.Now.instant().toString(), timeZone, guideDays,
			inputFingerprint: result.inputFingerprint, elapsedMs, ...phases,
			evaluatedChannels: allChannels ? schedules.length : 1, generatedChannels: commits.length, segments: result.segments.length,
			primarySpans: result.segments.filter(entry => entry.segment.role === 'primary').length,
			fillerSpans: result.segments.filter(entry => entry.segment.role === 'filler').length,
			decisionDigest: createHash('sha256').update(stableJson(schedulingDecisions(allChannels ? commits : result))).digest('hex') }));
	}
	finally {
		database.close();
	}
}

/** Run reproducible three- and seven-day comparisons against an explicitly supplied database. */
async function main(): Promise<void> {
	const { values } = parseArgs({ options: { database: { type: 'string' }, channel: { type: 'string' },
		now: { type: 'string' }, all: { type: 'boolean', default: false }, 'time-zone': { type: 'string', default: 'America/Los_Angeles' } } });
	if (!values.database || !values.channel || !values.now) {
		throw new Error('Usage: node --import tsx scripts/benchmark-filler.ts --database PATH --channel NUMBER --now ISO_INSTANT');
	}
	const instant = Temporal.Instant.from(values.now);
	const originalDate = globalThis.Date;
	const originalInstant = Temporal.Now.instant;
	const originalPlainDate = Temporal.Now.plainDateISO;
	// Fix scheduling timestamps while preserving Date's constructor, callable form, and timers.
	globalThis.Date = new Proxy(originalDate, {
		construct: (target, args) => Reflect.construct(target, args.length ? args : [instant.epochMilliseconds]),
		apply: () => new originalDate(instant.epochMilliseconds).toString(),
		get: (target, property, receiver) => property === 'now'
			? () => instant.epochMilliseconds : Reflect.get(target, property, receiver),
	});
	Temporal.Now.instant = () => instant;
	Temporal.Now.plainDateISO = zone => instant.toZonedDateTimeISO(zone ?? values['time-zone']).toPlainDate();
	try {
		for (const days of [3, 7]) {
			await benchmark(values.database, values.channel, days, values['time-zone'], values.all);
		}
	}
	finally {
		globalThis.Date = originalDate;
		Temporal.Now.instant = originalInstant;
		Temporal.Now.plainDateISO = originalPlainDate;
	}
}

await main();
