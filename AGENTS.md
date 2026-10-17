# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## Project

FamilyOS (FamOS) is a self-hosted, open-source, AI-assisted family organizer: shared calendar, tasks, shopping, and Quick add, which turns shared messages, photos and documents into draft cards that a human approves. It runs as a single Docker container on modest hardware such as a Raspberry Pi.

It covers a shared calendar, tasks and shopping, chores and a kitchen, household records (vehicles, pets, the home), a family board, Today and wall displays, notifications, Telegram and email, an assistant and a door for the family's own AI agents (MCP), backups, and language and theme packs.

## Read first

| Document | Purpose |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it is built: layers, packages, rules, flows, and the reason for each rule |
| [docs/design/design-system.md](docs/design/design-system.md) | Design system: page templates, components, the add and edit rules, settings mode, tokens |
| [docs/guide/](docs/guide/README.md) | The user guide: what each feature does for a family |

[docs/architecture.md](docs/architecture.md) describes the rules below and why they exist. They can change, but deliberately: a change to a rule updates architecture.md (and this file) in the same pull request, and is discussed with the maintainers first.

## Repository map

```
apps/server        Composition root: Hono API, WebSocket, worker loop, CLI
apps/web           SvelteKit SPA (adapter-static), PWA, i18n
packages/sdk       Port interfaces, defineExtension/defineAction, ID and slot types
packages/core      Kernel: members/RBAC, action runner, drafts, jobs, events, migrator, backup
packages/db        SQLite connection, Kysely setup, migration runner, backup snapshot
packages/adapters  Port implementations (queue-sqlite, files-fs, llm-aisdk, identity-betterauth, http-guard)
packages/i18n      Translation runtime, catalogs and language packs (i18next)
packages/themes    Theme pack contract: token list, validation, contrast, stylesheet generation
packages/time      Dates, time zones, recurrence (RRULE) and format-locale helpers (Temporal)
packages/testing   Test ctx on in-memory SQLite, fakes, port contract suites
packages/ui        Shared Svelte components, <Slot/>
packages/api-client  Generated from openapi.json (core and app routes) — never edit by hand
packages/pack      famos-pack: builds an extension into a package (dist/); shared-module lists, platform snapshot
apps/e2e           Playwright end-to-end tests against the production bundle
extensions/*       Features (calendar, lists, inbox, board, records, home, pets, vehicles, chores, kitchen, assistant, ambient); one package each
extensions.json    Which extension packages the image ships (always, offered, default)
languages/         Bundled language packs
themes/            Bundled theme packs: ev-isigi (the default), coast, forest, plum, paper, high-contrast
docs/              Architecture, design system, user guide, releasing
```

## Architecture rules (non-negotiable)

1. **Import boundaries** (enforced by dependency-cruiser):
   - Extensions import only `@famos/sdk`, `@famos/ui` and other extensions' `./contract`.
   - `core` imports only `sdk`. It never imports `db` or `adapters`.
   - `web` talks to the server only through `@famos/api-client`.
   - Only `apps/server` imports `db`, `adapters` and concrete libraries.
   - `apps/server` imports no extension; it loads the extension packages it finds at start.
2. **Extensions never import each other's internals.** Use actions (`ctx.actions.run`), events, or typed IDs. No foreign keys across extensions; prefix tables with the extension id (`shopping_items`). Each extension's manifest is the `famos` field of its package.json: declare every foreign action it runs in `famos.calls`, the extensions they belong to in `dependsOn` or `optional`, and every capability in `famos.capabilities`; the registry refuses a manifest that disagrees with the code, and each extension's context holds it to its manifest while it runs (its tables, files, secrets, calls and network).
3. **Access is capabilities, never role names.** Declare what your extension protects with `defineCapability` (choose a level: `view`, `use`, `edit`, `manage`), give routes `requires`, and give data-changing actions `requires` and/or `approval: { unless: capability }`. Never assume a household shape (parents/children): describe people only by their `about`. A sensitive extension may set capability `defaults` that only remove grants its level gives; it can never add one.
4. **Every state change is an action** (`defineAction`). Permissions and approval are enforced by the action runner, not in route handlers. Route handlers only validate, resolve the actor and delegate. The only exceptions are credential management (passwords, PINs, AI provider keys) and device trust: they set cookies or call an adapter outside a transaction.
5. **Zod is the single source of truth** for request/response shapes, action inputs, LLM structured output and draft forms. Do not duplicate types by hand.
6. **LLMs are never called inside an HTTP request.** (One exception: `core.searchFamily` embeds the search question in its `prepare` step, before the transaction, with a short timeout. Do not add others.) Enqueue a job; only job handlers get `ctx.llm` (`JobContext`), and every call names a model role and an explicit timeout. Handle `LlmError`: when `retryable` is false (no model set, bad key, limit reached), record the failure for the family instead of retrying. Model calls declare the `areas` they draw from; build AI catalogs with `aiCatalog({ local })`. Data for a prompt comes from the job's own item or from read-only actions invoked as the AI actor (`ctx.actions.invoke(id, input, { kind: 'ai', source })`); never query other extensions' tables for a prompt. Actions that send data outside the household are marked `external: true` and can never carry `ai` hints.
7. **Durable side effects go through the job queue**, enqueued in the same transaction as the data change. The in-process event bus is only for UI invalidation and non-critical reactions.
8. **AI does not change data directly.** Non-read-only actions invoked by AI produce drafts that a human approves. Actions AI may propose should declare `undo` (their inverse), so an approval can be taken back.
9. **Job handlers and action `run` functions must be idempotent.** Jobs that can run for minutes (uploads) use `lane: 'long'` so they never hold up reminders and notifications.
10. **Tell people with `uow.notify` / `ctx.notify`**: declare a kind with `defineNotificationKind`, address people by member id or capability, give texts as translation keys. Never call a channel directly.
11. **AI-facing read actions declare `ai` hints and return handles, never ids** (the host maps ids to handles).
12. **An extension may not be installed.** Only the always set (`extensions.json`) is certain; any other extension can be missing, refused or uninstalled with its data kept. Reach an `optional` extension only behind a check (its capability, `app.can('<id>.view')`, or a `not_found` from its action), never assume its tables or routes. An always installed extension never `dependsOn` an offered one. Installing, uninstalling and restarting are `core.*` actions behind the critical `core.extensions.manage`; the AI never runs or proposes an action that requires a critical capability.

- **Region-neutral**: no country-specific presets, defaults, enums, prompts or examples; language (words) is separate from region formats (dates, numbers, first day of week, units).

## Data and migrations

- `ctx.db` / `uow.db` are `Kysely<object>`: add your tables with `db.withTables<MyTables>()`.
- Query only your own extension's tables (named with your `tablePrefix`, `<id>_` by default): `ctx.db` and `uow.db` refuse anything else with `forbidden`, in queries, raw SQL, DDL and migrations. Read members and family settings through `ctx.family` / `uow.family` (inside a unit of work always `uow.family`, which reads through the transaction); reach other extensions through their actions (listed in `famos.calls`) and routes.
- Files: write only under `<id>/`. To let another extension read one of your files, grant it first (`uow.files.grant(key, 'records')`).
- Never call identity operations (`IdentityAdmin`) inside a unit of work: they share the single SQLite connection and would deadlock.

- SQLite only (WAL, STRICT tables, foreign keys on). Query with Kysely through `ctx.db`; there is no repository layer.
- Store timestamps as epoch milliseconds (UTC). Do date, timezone and recurrence math in TypeScript, not SQL.
- IDs are UUIDv7 strings with an entity prefix (for example `shop_item_…`).
- Migrations are **hand-written and forward-only** (no `down`), one folder per extension.
- **Expand-only** from the first release on: within a major version, only add tables, or nullable/defaulted columns. Never rename or drop columns, tables or API fields except in a major version, announced in advance.
- Never edit a migration that has been released. Add a new one.
- DB types are hand-written next to the migration that creates the table. Update them in the same change as the migration.

## API

- Define routes with `defineRoute` from `@famos/sdk` (never import Hono in an extension). They are served under `/api/v1/<extension>` with a stable `operationId` (`<extension>.<verbNoun>`); actions are exposed automatically at `POST /api/v1/actions/<id>`.
- A route can send text with its own content type (an ICS feed) by using `TextResponseSchema` as its `response`: return `{ text, contentType, cacheControl?, etag? }`; only `text/calendar`, `text/plain` and `application/json` keep their type (a matching `If-None-Match` gets `304`), and the response is sandboxed with `nosniff`. Its `cache-control` is the one place the API's `no-store` default is replaced.
- A route can send a stored file by using `FileResponseSchema` as its `response`; the server streams it sandboxed and only renders images and PDFs inline.
- After changing routes, run `pnpm gen` and commit what it writes: `apps/server/openapi.json` and `packages/api-client` (core's and the app's routes), and for each extension `extensions/<id>/openapi.json` and `src/web/api.gen.d.ts` (its routes and actions). CI fails if they drift.
- An extension's web client is `createApiClient<paths>()` with its own generated `paths` (`src/web/api.ts`); `@famos/api-client`'s own `paths` are the host's only. To read another extension's routes, import its `./api` types (`import type { paths as calendar } from '@famos/ext-calendar/api'`) and declare it in the manifest (`dependsOn` or `optional`); dependency-cruiser fails otherwise. `apps/web` never imports an extension's `./api`.
- Never edit generated files by hand.

## Frontend

- **Pages and forms follow [design-system.md](docs/design/design-system.md)**: pick one page template (no custom frames), one primary action per page, forms in a `SidePanel` (a sheet on phones), rows open on tap, secondary actions in a `⋯` menu, one filled button per view, sections are labels not boxes.
- Every page renders inside `<Page template=…>` (`@famos/ui/famos`); pages never set their own width or centring — a test enforces it (`scripts/page-frame.test.ts`).
- Svelte 5 runes, TypeScript, Tailwind v4, shadcn-svelte components, styled only through Ev Işığı tokens (`bg-surface`, `bg-idle`, `text-ink-soft`, `bg-attention` …). Never hard-code colors; semantic colors are never used for members.
- **Languages are packs**: write English only in code; never branch on a language code or hard-code a locale list; other languages come from packs in `languages/`. Code never holds words of a language, not even to recognize input: words it must match (command names, weekdays, units, keywords) are comma-separated catalog strings read with `ctx.vocabulary(key)` on the server (all installed languages) or `t(key)` in the UI; prompts are English only. `scripts/language-words.test.ts` fails on non-ASCII letters in strings and regular expressions.
- **Styles are code**: `STYLES` in `@famos/ui` (Broadsheet, Lanes, Wall) set Today's composition and the type ramp under `[data-style]`. Other pages use the role classes in `packages/ui/src/type.css` (`type-page`, `type-record`, `type-figure`, `type-day`, `type-dateline`) and never hard-code a font or a size for those roles; `accent` marks only "the next thing" (the hero on Today, the calendar's next event).
- **Themes are packs too**: the look is the token set in `packages/ui/src/theme.css`, whose names and meaning live in `@famos/themes` (`MODE_TOKENS`); bundled packs are in `themes/` (`pnpm theme:check <dir>`). Style only through tokens; a test fails on hard-coded colors. A new token needs a default in `themes/ev-isigi/tokens.json`, an entry in the token list and a line in `docs/guide/appearance.md`.
- No user-facing string literals in components. Use `t('key')` from `#lib/i18n.svelte.js`; add keys to `src/messages/en.json` (English is the only language the app's code writes). Catalogs register themselves: an extension keeps its English in `src/messages/en.json` and its translations beside it (`src/messages/tr.json`), passes them as `messages` to `defineExtension` (`{ en, tr }`) and to `defineWebExtension` (English), and the namespace is its manifest id; the host never imports an extension's catalog. Turkish of the app lives in `languages/tr/app.json`, an extension's in its own `tr.json`: add the translation in the same change, since a test fails CI if a bundled language is incomplete or has mismatched `{{placeholders}}` (`pnpm lang:check languages/tr`, `pnpm lang:check extensions/<id>`). Extensions register key types via `ResourceNamespaceMap`. Server-side text that is stored or sent (not shown through the UI) uses `ctx.translate` / `uow.translate` with a key in the extension's catalog.
- Shared components live in `@famos/ui` (vendored shadcn-svelte, not formatted by our tools). To add one, run the shadcn-svelte CLI in a scratch SvelteKit project and copy the component into `packages/ui/src/components/`, rewriting `#lib/utils.js` to `../../utils.js`, then add an export. There is no headless-UI library (no bits-ui): a component that needs one gets a plain Svelte 5 implementation.
- Extensions contribute UI only from their `./web` entry (`defineWebExtension`): nav entries, pages, slots (`dashboard.card`, `display.widget`, …), Today's timeline, facets and blocks, and draft presenters for their own actions. They never import the app's modules: app services (translation, members, time zone, realtime events, toasts, `share()`) come from `useApp()` in `@famos/ui/app`, and the API only through `@famos/api-client`. A slot an extension owns is declared in its contract (`FamosExtensionSlots`). Give `requires` to everything a family display may read. An extension's web code is typechecked by `svelte-check` with its `tsconfig.web.json`. The built app contains no extension: each `./web` is built into its package and imported by the browser at run time, getting Svelte, `@famos/ui`, `@famos/sdk`, zod, `@famos/time` and `@famos/api-client` from the app through an import map (`SHARED_WEB`; anything else it imports is bundled into the package), and its Tailwind utilities come in the package's own stylesheet (`ext` layer). `pnpm dev` compiles extension source instead, with hot reload.
- **The shell never names an extension.** `apps/web/src` reaches extensions only through the registry (`contributions`, filled by `registerWebExtension`): no `/api/v1/<extension>`, no `can('<extension>.…')`, no extension's page path or route folder (`scripts/shell-agnostic.test.ts`). What the shell needs from one becomes a contribution (a facet, a block, `nav.share`, a timeline's `page`).
- Words come from the reader's language; order, numbers, hour cycle, first weekday and units come from the family's region format. Dates and times go through the date locale, which joins the two (day and month names in the language, the region's order where `Intl` knows it): `app.dateLocale()` in extension UIs, `dateLocale(language, formatLocale, hourCycle)` from `@famos/time` on the server with the reader's language. Numbers and money use `app.formatLocale()` / `formatLocale` from `ctx.family.settings()`; weeks, clocks and weather use `app.weekStart()`, `app.hourCycle()`, `app.temperatureUnit()`. Never pass `app.locale()` to `Intl` or the date and money helpers, nor the format locale to a date or time formatter; a test scans for both. A date or time in a notification is a `{ date }`, `{ time }` or `{ at }` parameter, written out for each recipient when it is delivered.
- **A page opens once, whole** ([design-system.md](docs/design/design-system.md) 3.7): `PageGate` keeps every page invisible until its first reads have finished, so load data the usual way and render an empty state only from the load that proves emptiness. Do not add your own spinner or skeleton for the first load.
- Must work on phone width (~400px) and on a touch kiosk.

## Testing expectations

- Every action and route has tests using `@famos/testing` (in-memory SQLite with real migrations).
- Core tests use `packages/core/test/harness.ts`; extension tests use `createTestKernel` from `@famos/testing`.
- Tests never call real providers: use the scripted fake model (`k.llm.respond(...)` from `createTestKernel`).
- Quick add prompt, mention kind (description, slots, examples) or parser changes: run the evaluation matrix on at least two hosted models (`FAMOS_EVAL_API_KEY=… FAMOS_EVAL_MODELS=openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-4.1-mini pnpm --filter @famos/ext-inbox eval`; not in CI), single cases (`FAMOS_EVAL_CASE`) while fixing, then one full run with `FAMOS_EVAL_RECORD=1 FAMOS_EVAL_BASELINE=1`, and commit `baseline.json` and `recorded/`. No case that passed in the baseline may fail unless it is genuinely ambiguous (say why); an outage (the provider failed) counts neither way. Fix a misread in a resolver, an example or the parser, never with another prompt rule, and give it a test that replays the model's exact answer. Add a case to `extensions/inbox/eval/cases.ts` for every extraction mistake found in use.
- CI replays every recorded answer in `extensions/inbox/eval/recorded/` through the real pipeline with the fake model (`extensions/inbox/test/golden.test.ts`, on the eval's own household, `eval/household.ts`): each case's checks must pass, minus those the baseline lists as failing for that model. A replay that fails after a change to a resolver or the parser is a regression: fix the code, never the recording. The same test compares the fingerprint of everything the model is asked (fixed rules, host examples, every kind's description, slots and examples, the answer schema) with the `promptHash` in `baseline.json` and the recordings; when it fails with "prompt changed", run the full matrix with `FAMOS_EVAL_RECORD=1 FAMOS_EVAL_BASELINE=1` and commit the new `baseline.json` and `recorded/` (delete the old recordings first). Never edit the hash or a recording by hand. Recordings hold only the made-up eval cases, never family data.
- Assistant prompt or tool changes: run the assistant eval (`pnpm --filter @famos/ext-assistant eval`; not in CI) and add a case to `extensions/assistant/eval/cases.ts` for every assistant mistake found in use.
- Both evals run a model matrix: `FAMOS_EVAL_MODELS=openrouter:google/gemini-2.5-flash,openrouter:openai/gpt-4.1-mini` (an entry may end in `@<address>`, e.g. `ollama:qwen3:8b@http://pi.local:11434/v1`) prints one column per model with pass/fail, tokens, cost, time and finish reason per case, and what changed against `eval/baseline.json`. `FAMOS_EVAL_CASE=<substring>` runs some cases, `FAMOS_EVAL_CONCURRENCY=<n>` limits parallel cases, `FAMOS_EVAL_MAX_COST=<usd>` stops starting cases, `FAMOS_EVAL_REPORT=<path>` writes the result as JSON, `FAMOS_EVAL_RECORD=1` saves each model's answers to `eval/recorded/<model>/<case>.json`, `FAMOS_EVAL_RAW=1` prints them. While fixing, run one case on one model; before merging a prompt, schema or tool change, run every case on at least the two hosted models once with `FAMOS_EVAL_BASELINE=1` and commit the new `baseline.json`, with no case newly failing unless the pull request says why.
- New adapters must pass the port's contract test suite.
- Migration changes need an upgrade test from the previous release's fixture database.
- Logic gets unit tests (Vitest): layout math, selection, caching and other pure functions live in plain modules with a test beside them, not behind a browser.
- E2E (`apps/e2e`, Playwright) is a small set of essential user flows and security boundaries (setup and sign-in, roles, displays, Quick add, calendar, lists, a record page, backups, MCP, languages): about two dozen tests that run in under a minute. Add an e2e test only for a new essential flow or a new security boundary, never for layout, timing or screenshots. Each test starts the built server on its own copy of a data directory that global setup prepared once per run (migrated, set up with the admin Deniz) and starts signed in as Deniz; a test that covers setup or sign-in itself uses `test.use({ freshFamily: true })`. Every test has a fake OpenAI-compatible model (`support/`); run `pnpm --filter @famos/e2e exec playwright install --only-shell chromium` once. Set `FAMOS_E2E_LOG=1` to print the server's log (info and up) after the run when a test fails without an obvious cause.
- Screenshots for a UI review come from `pnpm sweep` (every page, empty and with data, day and night, 1440/1024/400, each style; `FAMOS_SWEEP_STYLES=wall` and `FAMOS_SWEEP_STATE=empty|data` narrow it). It is a review tool, not a gate.

## Commands

pnpm is pinned via `packageManager` (pnpm 12). If your global pnpm differs, use `corepack enable` or `npx pnpm@12.9.1 …`.

```bash
pnpm install
pnpm dev            # server (tsx watch, :3000) + web (vite, proxies /api) in watch mode
pnpm test           # unit and integration tests (Vitest)
pnpm e2e            # essential flows in Playwright against the production build (apps/e2e; fake model, temp data)
pnpm sweep          # screenshots of every page for a UI review (test-results/sweep; not a test)
pnpm release x.y.z  # bump, commit and tag a release locally (docs/releasing.md); a person pushes
pnpm lint           # Biome, Prettier (.svelte), dependency-cruiser
pnpm typecheck      # tsc and svelte-check
pnpm gen            # openapi.json, api-client types, each extension's openapi.json and api.gen.d.ts
pnpm build          # web SPA, bundled server (apps/server/dist) and extension packages (dist/extensions, which the built server loads)
docker compose up   # production-like run on http://localhost:3000

# server CLI (inside the container: node /app/server/famos.mjs <cmd>, the image's entry point, or main.mjs)
# from source the server loads the extensions' source only when told where it is
FAMOS_DEV_EXTENSIONS=../../extensions pnpm --filter @famos/server exec tsx src/main.ts migrate|backup|restore <file>|openapi
# which extensions a family has (also Settings → Family → Extensions): a new family starts with the always set
# and the defaults (photos & weather); changes load at the next start
node apps/server/dist/famos.mjs extensions list|install <id…>|install --all-offered|uninstall <id>
# remove an uninstalled extension's data for good (backup first; asks unless --yes); command line only
node apps/server/dist/famos.mjs extensions purge <id> [--yes]
```

Before declaring work done, run `pnpm lint`, `pnpm typecheck` and `pnpm test` and report the results honestly.

## Conventions

- **Language:** code, comments, commit messages and docs are in English. The UI is internationalized (English and Turkish).
- TypeScript strict; no `any` without a comment explaining why.
- Formatting and linting with Biome (TS/JS/JSON/CSS) and Prettier (`.svelte` only); do not hand-format.
- Dependencies are pinned to exact versions. Do not add a dependency without checking its maintenance status and peer ranges; prefer small, low-churn packages. See "Dependency policy" in docs/architecture.md.
- TypeScript 6 with `erasableSyntaxOnly`: no enums, namespaces or parameter properties.
- Commits follow Conventional Commits (`feat(shopping): …`, `fix(core): …`). The type and scope matter: release notes are generated from commit messages, so describe user-visible changes in user terms and mark breaking changes (`feat!:` or a `BREAKING CHANGE:` footer).
- Keep changes small and scoped to the task; do not refactor unrelated code.
- Prefer the simplest design that respects the rules above.
- **Comments in code explain themselves** and never cite documents, decision records, plans or phases. Say why the code is the way it is in the comment itself; the reasons behind the rules live in docs/architecture.md.

## Security and privacy

- PIN sign-in and the profile picker only work on trusted family devices (`core_devices`, kind `family`); never add another path that reveals member names or accepts PINs without that check. Displays (kind `kiosk`) never get PIN sign-in, profiles or write access: they hold only granted `view` capabilities and cannot run actions.

- Never log secrets, API keys, PINs or the contents of family documents.
- A credential an extension must keep (a calendar subscription URL is one) is sealed with `ctx.secrets` / `uow.secrets` (AES-GCM, a key of the extension's own derived from `FAMOS_SECRET`) and never returned to the browser or logged; show a host or a hint instead.
- Outbound requests to addresses a user typed go through `ctx.http.get` (SSRF guard: https only, no private/loopback/link-local addresses unless `allowLocal`, same-host redirects, size cap, timeout). Call it from job handlers only; extensions never use `fetch` for such addresses. It reaches only what the manifest's `network` declares (`hosts`, `userUrls`, `local`).
- Provider API keys are stored encrypted in the database (key from `FAMOS_SECRET`).
- Extension code runs only from the image (trusted by place) or from the store, trusted by an ed25519 signature against `TRUST_ROOTS` (`apps/server/src/packages/trust.ts`), checked at install and at every start. Never add a setting, environment variable or unsigned path that loads package code in production.
- Do not add telemetry or calls to external services that the family has not explicitly configured.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
