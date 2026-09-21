# UI performance pass — September 2026

The pass targets browser main-thread work, starting with Guide/Channels navigation. Measurements use production builds in local Chromium at 1440 × 900, synthetic API responses, and the same machine before and after. Playwright tracing is disabled for timings because recording DOM snapshots substantially increases the measured work. Values include test dispatch overhead and are comparisons, not portable service-level guarantees.

## Before and after

The standard guide contains 20 channels, 48 half-hour programmes per channel per day, and seven days (6,720 segments). Warm navigation values are medians of three switches in each direction. Each measurement also waits for the fresh seven-day response.

| Measurement | Before | After |
| --- | ---: | ---: |
| Switch to Guide | 1,505 ms | 174 ms |
| Switch to Channels | 766 ms | 192 ms |
| Guide browser task time, including refresh | 1,442 ms | 108 ms |
| Guide layout time | 211 ms | 7 ms |
| Cold Guide first paint | 662 ms | 347 ms |
| Exit Guide to Libraries | 48 ms | 30 ms |
| Mounted Guide rows | 20 | 6 |
| Retained Guide heap after collection | 17.2–17.5 MB | 11.3–11.7 MB |
| Largest observed long task over the run | 1,252 ms | 74 ms |
| Append the tenth log page, browser task time | 393 ms | 81 ms |
| Open a 5,000-program catalog | 913 ms | 330 ms |

The optimized guide retained exactly 2,039 DOM nodes and 872 event listeners at each of three measured Guide visits. Exiting left 288 nodes and 53 listeners, matching the baseline application shell. This checks repeated-navigation retention; it is not a proof against every possible memory leak.

A separate pure sorting comparison for 5,000 shuffled names fell from approximately 706 ms to 10 ms by normalizing titles once and reusing a collator. The catalog browser comparison above measures the complete route instead. Template filtering also avoids assignment scans when no channel filter is selected.

## Changes

- Measure before mounting listings, virtualize large channel lineups with natural measured heights, and preserve page scrolling and keyboard access. Small previews retain all rows.
- Query lazy per-channel interval indexes rather than scanning the week on scroll. Index ownership is weak, so replacing a snapshot does not create an accumulating cache.
- Retain guide responses as shallow snapshots; derive styles, artwork choices, and date labels only for mounted listings. Scale calendar geometry without repeating timezone calculations.
- Share concurrent route-bootstrap guide requests while allowing authoritative refreshes to supersede them.
- Reuse log timestamp formatters and skip rendering unchanged log rows during pagination. Preserve existing sorting semantics while reusing name and channel-number collators.

## Broader audit and limits

A synthetic 1,000-item library page mounted 24 cards and painted in approximately 418 ms. Four active dashboard sessions used approximately 93 ms of browser task time across 3.2 seconds of clock updates. These workflows already use virtualization or bounded/coalesced updates; no speculative rewrite was added. Scheduling catalog/editor navigation and real template preview/popover interactions were also exercised.

At four-times CPU throttling, the standard guide switched to Guide in a median 399 ms and Channels in 451 ms; the largest observed task was 374 ms. A near-limit workload of 100 channels and 199,500 segments mounted six Guide rows (786 visible/overscanned listings), used a median 406 ms of browser task time per Guide switch, and had a largest task of 209 ms. Its 1.82-second median navigation includes synthetic response serialization overhead. Retained heap stayed around 62–62.5 MB across three visits, and exiting returned to the same 288-node shell while retaining approximately 60 MB, including the cached snapshot. These are optimized stress runs, without matching pre-change stress baselines.

The most recent full guide remains cached intentionally. Large response parsing and very dense visible timelines can still produce long tasks; this pass does not change the HTTP payload, server limits, or move parsing to a worker. Timings exclude real server generation and network latency. Synthetic fixtures do not cover every artwork size, client device, library shape, or authored schedule.

See [the profiling instructions](../tests/e2e/performance/README.md) for repeatable runs, CPU throttling, near-limit workloads, and saved JSON measurements. Focused unit tests and browser regressions cover interval boundaries/overlaps, DST geometry, progressive loading and retries, channel saves, keyboard traversal, sticky labels, artwork, popovers, and responsive rows.
