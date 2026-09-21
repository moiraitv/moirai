# UI performance checks

Build the production web app before profiling:

```sh
npm run build -w @moirai/web
npx playwright test --config playwright.performance.config.ts
```

The suite starts a loopback-only Vite preview and intercepts API/WebSocket requests with synthetic fixtures. It does not start the application server or read/write its database. Profiling tests disable Playwright tracing because DOM snapshots materially distort CPU and navigation measurements; behavioral tests retain failure traces.

The guide profile accepts these environment variables:

- `GUIDE_CHANNELS` (default 20)
- `GUIDE_SEGMENTS_PER_DAY` (default 48 per channel)
- `GUIDE_NEAR_LIMIT=1` (derive density from `MAX_GUIDE_TIMELINE_SEGMENTS`)
- `GUIDE_CPU_RATE` (default 1; use 4 for a throttled run)

For example:

```sh
GUIDE_CHANNELS=100 GUIDE_NEAR_LIMIT=1 npx playwright test --config playwright.performance.config.ts guide-profile
GUIDE_CPU_RATE=4 npx playwright test --config playwright.performance.config.ts guide-profile
```

JSON attachments under `test-results/performance` record navigation-to-paint, CPU/layout durations, long tasks, rendered rows/listings, and retained heap/DOM/listeners across repeated visits and after exit. Navigation timings include Playwright dispatch and synthetic response serialization; they are not server latency measurements. Cold entry includes the production bundle download and first-day response. Full-week refreshes are awaited separately before collecting CPU totals.

The log profile accumulates ten 100-entry pages, extending the polling interval inside the test so background refresh cannot replace the accumulated pages. The catalog profile exercises 5,000 programs, 100 templates, filtering, and editor navigation. Behavioral tests cover initial DOM bounds, horizontal/vertical scrolling, keyboard navigation, grouped listings, artwork, and responsive layout. Run the ordinary end-to-end suite for server-backed saves and scheduling behavior.

Compare repeated runs on the same machine, browser, viewport, and CPU setting. Timing values are diagnostic evidence rather than CI pass/fail thresholds; structural and functional assertions are deterministic.
