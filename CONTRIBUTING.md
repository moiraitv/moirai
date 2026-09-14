# Contributing to Moirai

Start with the [README](README.md) for installation and a quick local setup. This page covers development workflows and verification commands. Follow [AGENTS.md](AGENTS.md) for repository conventions, testing expectations, and documentation rules; these guidelines apply to human and automated contributions.

Report ordinary bugs through GitHub issues. For vulnerabilities, follow the [security policy](SECURITY.md) and use private reporting instead of posting security details publicly.

## Running developer instances

Run the commands below from the root of the checkout or worktree you want to test. Use development-only data, not a running production instance's database or playback directories.

### Initial setup

Use Node.js 24.8 or newer within the Node 24 LTS line, as specified by `.nvmrc` and `package.json`. Install FFmpeg so `ffprobe` is available on `PATH`. For live playback, also install a Rust toolchain and build the pinned ErsatzTV Next worker:

```sh
nvm use
npm install
npm run etv:setup
npm run etv:build
```

The root npm overrides keep VitePress 1.6.4 on patched stable Vite and Vue plugin releases. These
versions exceed VitePress's declared dependency ranges. Vite 7 retains the Rollup behavior needed
for VitePress 1.6.4 to emit its initial-page chunks; Vite 8 does not. Dependency updates must verify guide
builds, development HMR, navigation, search, and the review page. Remove the scoped overrides when
a stable VitePress release declares patched dependencies that pass those checks.

The management UI can run without the playback worker, but live playback will be unavailable and reported as degraded. `MOIRAI_ETV_CHANNEL_PATH` can point to an existing standalone worker instead. If you installed dependencies under a different Node version, run `npm rebuild better-sqlite3` after switching to Node 24.

Optionally copy `.env.example` to `.env` if no local `.env` exists yet, and adjust it for this instance. Do not overwrite an existing configuration or commit secrets. `npm run dev` loads this ignored root file; explicitly exported environment variables take precedence.

### Normal development

```sh
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The coordinator starts the API on port 3000, then Vite on port 5173. Vite provides frontend hot updates and proxies API requests; server and shared-source changes trigger API rebuilds and restarts. Stop the coordinator with Ctrl+C to stop the instance.

On a fresh data directory, initialize administrator access in the browser using a local account or a configured Logto provider. Keep the instance bound to loopback until setup is complete. See the [configuration reference](apps/docs/src/operations/configuration.md) for remote-host settings and [Logto setup](apps/docs/src/getting-started/access.md#set-up-logto) for provider configuration.

By default, persistent state lives under `data/` in the repository. Relative playback stream and playout paths are resolved beneath `MOIRAI_DATA_DIR`; `MOIRAI_LOG_DIR`, when explicitly set, is resolved from the repository root. Check overrides in `.env`, especially absolute paths, before launching another instance.

### Run a second instance alongside the first

Use a separate checkout or Git worktree for each simultaneously running development instance so builds do not compete for the same output files. Install its dependencies and prepare the playback worker there too, or point it to a compatible prebuilt worker.

From that second checkout's root, this example uses separate ports and a separate directory under ignored `data/`:

```sh
MOIRAI_HOST=127.0.0.1 \
MOIRAI_PORT=3001 \
MOIRAI_WEB_PORT=5174 \
MOIRAI_PUBLIC_URL=http://127.0.0.1:3001 \
MOIRAI_MANAGEMENT_URL=http://127.0.0.1:5174 \
MOIRAI_DATA_DIR=./data/dev-secondary \
MOIRAI_LOG_DIR=./data/dev-secondary/logs \
MOIRAI_PLAYBACK_STREAM_DIR=streams \
MOIRAI_PLAYBACK_PLAYOUT_DIR=playout \
npm run dev
```

Open [http://127.0.0.1:5174](http://127.0.0.1:5174). Each instance needs unique API and web ports and must not share its writable database, logs, stream, or playout directories with another running instance. Merely changing the browser port is not sufficient. Each fresh data directory has its own administrator setup and configuration.

Browser cookies are scoped by hostname, not port. Use separate browser profiles for simultaneous instances on `127.0.0.1` to avoid session-cookie collisions. If using distinct hostnames instead, keep each instance's public and management URLs on the same scheme and hostname; only their ports may differ. For OIDC, configure the matching redirect and sign-out URLs for each development instance.

### Test the built application and bundled guide

Stop the development instance before reusing its ports or data, then run:

```sh
npm run build
node --env-file-if-exists=.env apps/server/dist/main.js
```

This serves the built application and bundled `/help/` guide from the API origin, normally [http://127.0.0.1:3000](http://127.0.0.1:3000), without Vite or hot reload. The explicit Node command loads `.env`; `npm start` does not load it automatically. If `.env` sets `MOIRAI_MANAGEMENT_URL` to a Vite port, change or override that setting to match the API origin for this single-server run. Reapply any instance-specific environment overrides you used above; shell-prefix values apply only to that command, not future commands.

For guide-only editing, run `npm run docs:user:dev` and use the URL printed by VitePress. Ordinary builds allow documentation drafts; use the release checklist below for the review-gated production build.

## Verification

Run these commands from the repository root:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run docs:user:check
npm run docs:api:check
npx playwright install chromium
npm run test:e2e
```

Set `PLAYWRIGHT_CHROME_PATH` to an existing Chrome or Chromium executable if you do not use Playwright's downloaded browser. Follow the [release checklist](#before-a-release) before running `npm run build:production`; production and Docker builds require explicit approval of the current guide content.

### API references

Generate offline HTTP and live-event API references with:

```sh
npm run docs:api
```

This writes OpenAPI 3.1 and AsyncAPI 3.1 JSON, YAML, and self-contained HTML under the ignored `dist/api-docs/` directory. Open `dist/api-docs/index.html` to browse them. These developer references are not served as production routes. See the [technical outline](docs/technical-outline.md) and [scheduling architecture](docs/scheduling-architecture.md) for implementation details.

## Where documentation belongs

- **User tasks and how-tos:** `apps/docs/src/`, published in the bundled `/help/` guide. Keep instructions understandable without developer knowledge, use the application's labels and icons, and leave Markdown paragraphs unwrapped so editors can soft-wrap them.
- **Architecture and implementation contracts:** the [technical outline](docs/technical-outline.md) and focused references under `docs/`.
- **HTTP and event interfaces:** shared contracts and route descriptions, verified with `npm run docs:api:check`. See [API references](#api-references) for generating offline documentation.
- **Contributor workflows and release checks:** this file. Keep the README concise and link to detailed instructions rather than duplicating them.

## Updating the user guide

User-visible changes should include the affected guide topics and screenshots in the same contribution. This includes layout and styling changes that make existing screenshots inaccurate, even when functionality is unchanged.

Edit the Markdown under `apps/docs/src/`. Preserve existing topic IDs and use assets under `apps/docs/src/public/screenshots/` or `apps/docs/src/public/icons/`. Extend the real-browser capture scenario in `tests/e2e/user-documentation.spec.ts` when a new workflow or screenshot is needed. Keep fixture content sanitized; never capture a real user's library, credentials, or private paths.

Preview the guide with `npm run docs:user:dev` using the URL it prints. Unreviewed pages show their topic ID and repository-relative source path at the top; `/help/review.html` lists outstanding reviews with Before/After image toggles (After is selected initially) and unified Markdown text diffs. Comparisons use a version from the last 100 available guide commits only when its complete digest matches the recorded approval; missing history is clearly labeled, never substituted with an unapproved baseline. Run `npm run docs:user:build` after editing text or regenerating screenshots to refresh the comparison page. `npm run docs:user:review:list -- --json` provides a machine-readable queue.

Approvals in `apps/docs/reviews.json` apply to a digest of the page and its referenced local images. Changing prose, links, screenshots, or icons can invalidate that approval. Do not hand-edit digests or approve changes just to make a build pass. Automated contributors may approve a topic only after an explicit user instruction.

The review queue identifies whether text, screenshots, icons, or a combination changed. Text includes Markdown links and frontmatter. New pages require an initial review; legacy approvals whose original contents cannot be verified require a full review. Approval still applies to the whole topic, not just one category. To migrate a legacy registry, run `npm run docs:user:review:migrate` **before** editing or regenerating images. Only matching approvals receive component baselines, with their original approval times preserved; listing and checking never rewrite approvals.

Documentation captures run separately from ordinary browser tests using `playwright.docs.config.ts`. Each workflow starts its own real backend and isolated data, with a fixed clock, UTC timezone, and `en-US` browser locale. For a focused temporary capture, run `npx playwright test --config playwright.docs.config.ts --grep 'captures Templates'` (other groups cover setup, libraries, Programs, Channel Schedules/Guide, and channel settings/operations). The application builds once per invocation. Temporary output is under ignored `test-results/docs-screenshots`; focused runs do not update guide images. `npm run test:e2e` runs both browser suites.

Capture fixtures normalize machine identifiers in their isolated log files, use distinct fixed Program colors, and wait for posters and paused video previews to load. They do not replace application API responses for screenshots. To check reproducibility, add `--repeat-each=2`; the second image set is retained under `test-results/docs-screenshots/repeat-1` for comparison with the first.

## Before a release

To build a locally tagged Docker image from the repository directory, run:

```sh
docker build -t moirai:local .
```

Use `moirai:local` when starting a container from this development image. Docker builds enforce the documentation review gate described below.

Run these commands from the repository root after the release's UI and documentation changes are ready:

1. Ensure the development dependencies and a browser are available. Install Playwright's browser with `npx playwright install chromium`, or set `PLAYWRIGHT_CHROME_PATH` to an existing Chrome/Chromium executable. See the README for other development prerequisites.
2. Regenerate documentation screenshots against the current application:

   ```sh
   npm run docs:user:screenshots:update
   ```

   This runs all isolated capture workflows into temporary staging and publishes the complete set to `apps/docs/src/public/screenshots/` only after every test succeeds. A failed capture leaves guide images unchanged. There is no background screenshot watcher. Inspect changed images for loading states, clipped controls, incorrect colors, misleading sample data, and sensitive information. Captures are not automated visual-baseline approval, and pixel identity is only expected with the same browser/platform.

3. Validate and build the guide, then list the review queue:

   ```sh
   npm run docs:user:check
   npm run docs:user:build
   npm run docs:user:review:list
   ```

4. Review the rendered pages and screenshots. After explicit approval, record each topic's current digest with the following command, replacing `TOPIC_ID` with its ID:

   ```sh
   npm run docs:user:review:approve -- TOPIC_ID
   ```

   Approve all topics only when a reviewer has explicitly approved all current content. Regenerate screenshots **before** approval: image changes can put previously reviewed pages back in the queue. Commit the reviewed Markdown, image assets, capture-scenario changes, and approval registry together.

5. Run the application's [verification checks](#verification), then build the release:

   ```sh
   npm run build:production
   ```

   Production and Docker builds fail while any guide page is unreviewed. Ordinary `npm run build` remains draft-friendly. The production build rebuilds the bundled guide with the latest review state.

**The review gate is not a screenshot-freshness check.** It validates approval of the files currently on disk; it does not determine whether an old screenshot still matches changed UI code. Regenerating screenshots and visually reviewing them before release is therefore a required contributor step, not something the production build performs automatically.

## Publishing a GitHub release

The workflow in `.github/workflows/publish-image.yml` builds the release's tagged commit and publishes
its Docker image to `ghcr.io/<owner>/<repository>` when a GitHub release is **published**. Saving a
draft or pushing a Git tag alone does not publish an image. The image name is derived automatically
from the GitHub repository and normalized to lowercase by Docker's metadata action.

Before the first public release:

1. Choose a project license and retain the required third-party licenses and notices. Review tracked
   files and Git history for credentials, personal data, and files that should not be public.
2. Create the GitHub repository, configure its Git remote, and push the prepared commits, including
   the publishing workflow. Enable GitHub Actions and allow the workflow's `packages: write`
   permission. It uses GitHub's automatic `GITHUB_TOKEN`; no registry password or personal access
   token needs to be stored as a secret.
3. Verify that **Settings → Advanced Security → Private vulnerability reporting** is enabled and that maintainers receive security notifications through **Watch → Custom → Security alerts** (or **All Activity**). Confirm that GitHub displays the root `SECURITY.md` policy and the **Report a vulnerability** button after publication. Adding the policy file does not enable private reporting. See [GitHub's setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) for reporting and notification settings.
4. Update the installation examples to use the final GHCR image address. Complete the release checks
   above, including screenshot regeneration and explicit guide approval, and smoke-test the Docker
   image with fresh application data. The workflow enforces the Dockerfile's production build and
   guide review gate; it does not run the full application test suite.
5. Commit the release preparation, push it, and publish a release with a version tag such as
   `v0.1.0`. Keep the package versions consistent with the release. Mark previews as prereleases.
6. Wait for **Publish Docker image** in the Actions tab to succeed. After the first publication, open
   the package settings and change its visibility to **Public**. A public source repository does not
   automatically make a newly published container package public. Verify an anonymous image pull
   before announcing the release.

A stable `v0.1.0` release publishes `:v0.1.0`, `:0.1.0`, and `:latest`. Prereleases publish their
version tags without changing `latest`; tags containing a hyphen also never update `latest`. Use a
specific version tag for reproducible installations. Every successful stable release publication
updates `latest`, so publishing or rerunning an older stable release can move that alias backwards.
The image currently targets `linux/amd64`, matching the pinned upstream engine.

If publication fails, inspect the failed Actions step and rerun the workflow after resolving the
cause. A source fix needs a new commit and release tag; do not move an already published version tag.
GitHub's release page is published before the image build completes, so its existence alone does not
mean the container is ready to pull.
