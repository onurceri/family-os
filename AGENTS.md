# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## Project

FamilyOS (FamOS) is a self-hosted, open-source, AI-assisted family organizer in a single Docker container on modest hardware (a Raspberry Pi): calendar, tasks and shopping, chores, kitchen, household records, a board, Today and wall displays, notifications, Telegram and email, Quick add (shared messages, photos and documents become draft cards a human approves), an assistant, an MCP door for the family's own AI agents, backups, and language and theme packs.

## Read first

| Document | Purpose |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How it is built: layers, packages, rules, flows, and the reason for each rule |
| [docs/design/design-system.md](docs/design/design-system.md) | Design system: page templates, components, the add and edit rules, settings mode, tokens |
| [docs/guide/](docs/guide/README.md) | The user guide: what each feature does for a family |

This file is the checklist; architecture.md gives each rule's reason. To change a rule, discuss it with the maintainers first and update architecture.md and this file in the same pull request.

## Repository map

```
apps/server        Composition root: Hono API, public API for connected apps, WebSocket, worker loop, CLI
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
extensions/*       Features (calendar, lists, inbox, board, records, home, pets, vehicles, chores, kitchen, assistant, ambient, homeassistant); one package each
extensions.json    Which extension packages the image ships (always, offered, default) and which are released on their own (independent)
languages/         Bundled language packs
themes/            Bundled theme packs: ev-isigi (the default), coast, forest, plum, paper, high-contrast
docs/              Architecture, design system, user guide, releasing
```

## Architecture rules (non-negotiable)

1. **Import boundaries** (enforced by dependency-cruiser):
   - Extensions import only `@famos/sdk`, `@famos/ui` and other extensions' `./contract`.
   - `core` imports only `sdk`, never `db` or `adapters`.
   - `web` talks to the server only through `@famos/api-client`.
   - Only `apps/server` imports `db`, `adapters` and concrete libraries.
   - `apps/server` imports no extension; it loads the extension packages it finds at start.
2. **Extensions never import each other's internals.** Use actions (`ctx.actions.run`), events, or typed IDs. No foreign keys across extensions; table names carry the extension's prefix (`shopping_items`; see Data). The manifest is the `famos` field of the extension's package.json: every foreign action it runs in `famos.calls`, their extensions in `dependsOn` or `optional`, every capability in `famos.capabilities`. The registry refuses a manifest that disagrees with the code, and at run time the extension's context holds it to its manifest (tables, files, secrets, calls, network).
3. **Access is capabilities, never role names.** Declare them with `defineCapability` (level `view`, `use`, `edit` or `manage`); routes get `requires`, data-changing actions `requires` and/or `approval: { unless: capability }`. Never assume a household shape (parents/children); describe people only by their `about`. A sensitive extension's capability `defaults` may only remove grants its level gives, never add one. Access is closed by default: never compare `actor.kind` to pick a member or to mean "a person is here"; use `selfOf`, `memberBehind`, `personPresent`, `principalOf` (and `appOf`) from `@famos/sdk`, so a caller without a self is never a free pass. An action run inside another (`uow.run`) is decided like any call and refused when it would need approval, unless the inner action is marked `nested: { governedBy: 'owner' }` and the caller owns the record (`recordIds`).
4. **Every state change is an action** (`defineAction`). The action runner enforces permissions and approval; route handlers only validate, resolve the actor and delegate.
   - **The only exception is setting a secret**, which stays a route (it sets cookies, shows a secret once while an action's answer is kept for replays, or calls an adapter outside a transaction) and records itself with `kernel.audit.record(actor, operationId, target)`: a password, a PIN, an AI provider key, minting an app key or AI-app (MCP) key, OAuth sign-in for AI apps (approval, tokens, client secrets), device trust and pairing, a backup passphrase, a backup target's address and keys, saving the server's key file (asks for the password again), and saving the family mailbox with its password.
   - Everything else around a secret is an action: an app's record, pausing it, revoking a key, app or device, the MCP and OAuth switches (`core.setMcpOAuth`), removing an app set up to sign in (`core.deleteOAuthClient`), what a display may show, every other AI provider, backup and mailbox setting (run a backup now, its encryption choice, checking mail now), unlinking Telegram.
   - An action only jobs and the AI run (a feed's last-read mark) is `expose: 'internal'`: no route, refused for people and displays.
   - Each door admits only its own caller kinds (`authenticate`): `/api/v1` and the socket a session cookie (an `Authorization` header is refused); `/mcp` only a bearer (a personal key, or an access token FamilyOS's own authorization server issued for `/mcp`); the OAuth endpoints (`/.well-known/oauth-*`, `/oauth/*`, the `oauth` door) no caller and no cookie, as they authenticate OAuth clients, never people. Approving an AI app's sign-in is a session route that needs a person present, a password sign-in and `core.mcp.use`. The runner enforces a token's `scope` and `conversationOnly` on the actor.
5. **Zod is the single source of truth** for request/response shapes, action inputs, LLM structured output and draft forms. Never duplicate types by hand.
6. **LLMs are never called inside an HTTP request.** The one exception: `core.searchFamily` embeds the question in its `prepare` step, before the transaction, with a short timeout; add no others. Enqueue a job; only job handlers get `ctx.llm` (`JobContext`), and every call names a model role and an explicit timeout. Handle `LlmError`: when `retryable` is false (no model set, bad key, limit reached), record the failure for the family instead of retrying. Model calls declare the `areas` they draw from; build AI catalogs with `aiCatalog({ local })`. Prompt data comes from the job's own item or from read-only actions invoked as the AI actor (`ctx.actions.invoke(id, input, { kind: 'ai', source })`), never from other extensions' tables. Actions that send data outside the household are `external: true` and never carry `ai` hints.
7. **Durable side effects go through the job queue**, enqueued in the same transaction as the data change; the in-process event bus is only for UI invalidation and non-critical reactions.
   - Every event declares who may hear of it (`defineEvent(name, payload, { audience })`: a capability, a member, or a function of the payload for row-level cases). The realtime hub filters per socket; an event without an audience goes only to holders of its owner's `view` capability. Payloads carry no text the audience may not see.
   - An event about a thing apps may read also declares `changes` (`{ entity, id, op }` per thing; `delete` for anything gone for readers); the runner writes them to the change log in the same transaction. A job writing its own tables uses `ctx.unit(…)`, not `ctx.db` alone, so its change is logged too.
   - Tables apps may read have a `version` (`addVersion` in the migration: a trigger counts every write; `bumpParentVersion` for a child its parent shows), and actions changing them name it in `target.versionColumn` so `ifMatch` can refuse a stale write.
8. **AI does not change data directly.** Non-read-only actions invoked by AI produce drafts a human approves. Actions AI may propose declare `undo` (their inverse), so an approval can be taken back.
9. **Job handlers and action `run` functions are idempotent.** Jobs that can run for minutes (uploads) use `lane: 'long'` so they never hold up reminders and notifications.
10. **Tell people with `uow.notify` / `ctx.notify`**: declare a kind with `defineNotificationKind`, address people by member id or capability, give texts as translation keys. Never call a channel directly.
11. **AI-facing read actions declare `ai` hints and return handles, never ids** (the host maps ids to handles).
12. **An extension may not be installed.** Only the `always` set (`extensions.json`) is certain; any other can be missing, refused or uninstalled with its data kept. Reach an `optional` extension only behind a check (its capability, `app.can('<id>.view')`, or a `not_found` from its action); never assume its tables or routes. An always installed extension never `dependsOn` an offered one. Installing, uninstalling and restarting are `core.*` actions behind the critical `core.extensions.manage`; the AI never runs or proposes an action that requires a critical capability.
13. **A connected app is not a person.** An app (Home Assistant, a script) is the actor `{ kind: 'app' }`, or a member with `via` when it acts for one. Neither is `personPresent`, and neither ever holds a critical capability, `core.drafts.approve`, `core.mcp.use` or `core.signIn.pin` (`appMayHold`); an app in `suggest` mode only makes drafts. For anything only a person may do, ask the rule 3 helpers, never `actor.kind === 'member'` alone. An OAuth client is neither a person nor an app: its token is the same AI actor as a personal key (`{ kind: 'ai', mode: 'agent', source: 'mcp' }`) for the member who approved it, and no door accepts a token another issuer made. App keys live in `core_app_tokens` (minting one is a route, rule 4; the app, pausing, resuming and revoking it or a key are `core.*` actions); all of it needs `core.apps.manage` and a password sign-in. A restore pauses every app.

- **Region-neutral**: no country-specific presets, defaults, enums, prompts or examples. Language (words) is separate from region formats (dates, numbers, first day of week, units).

## Data and migrations

- `ctx.db` / `uow.db` are `Kysely<object>`: add your tables with `db.withTables<MyTables>()`.
- Query only your own extension's tables (named with your `tablePrefix`, `<id>_` by default): `ctx.db` and `uow.db` refuse anything else with `forbidden`, in queries, raw SQL, DDL and migrations. Read members and family settings through `ctx.family` / `uow.family` (inside a unit of work always `uow.family`, which reads through the transaction); reach other extensions through their actions (listed in `famos.calls`) and routes.
- Files: write only under `<id>/`. To let another extension read one, grant it first (`uow.files.grant(key, 'records')`).
- Never call identity operations (`IdentityAdmin`) inside a unit of work: they share the single SQLite connection and would deadlock.
- SQLite only (WAL, STRICT tables, foreign keys on), queried with Kysely through `ctx.db`; no repository layer.
- Timestamps are epoch milliseconds (UTC). Do date, timezone and recurrence math in TypeScript, not SQL.
- IDs are UUIDv7 strings with an entity prefix (`shop_item_…`).
- Migrations are **hand-written and forward-only** (no `down`), one folder per extension. Never edit a released migration; add a new one.
- **Expand-only** from the first release on: within a major version, only add tables or nullable/defaulted columns. Renaming or dropping columns, tables or API fields happens only in a major version, announced in advance.
- DB types are hand-written next to the migration that creates the table, and updated in the same change as the migration.

## API

- Define routes with `defineRoute` from `@famos/sdk` (extensions never import Hono). They are served under `/api/v1/<extension>` with a stable `operationId` (`<extension>.<verbNoun>`). Actions are exposed automatically at `POST /api/v1/actions/<id>`, except `expose: 'internal'` ones (no route, not in the OpenAPI document).
- Text with its own content type (an ICS feed): `response: TextResponseSchema`, return `{ text, contentType, cacheControl?, etag? }`. Only `text/calendar`, `text/plain` and `application/json` keep their type; a matching `If-None-Match` gets `304`; sent sandboxed with `nosniff`. Its `cache-control` is the only override of the API's `no-store` default.
- A stored file: `response: FileResponseSchema`; streamed sandboxed, only images and PDFs inline.
- After changing routes, run `pnpm gen` and commit what it writes: `apps/server/openapi.json`, `apps/server/public-openapi.json`, `packages/api-client` (core's and the app's routes), and per extension `extensions/<id>/openapi.json` and `src/web/api.gen.d.ts`. CI fails if they drift. Never edit generated files by hand.
- An extension's web client is `createApiClient<paths>()` with its own generated `paths` (`src/web/api.ts`); `@famos/api-client`'s `paths` are the host's only. To read another extension's routes, import its `./api` types (`import type { paths as calendar } from '@famos/ext-calendar/api'`) and declare it in `dependsOn` or `optional` (dependency-cruiser fails otherwise). `apps/web` never imports an extension's `./api`.
- **The public API (`/api/public/v1`, for connected apps) offers only what an extension marks**; mark only what a program has a reason to use: an action with `expose: defineApi({ name, method, path, summary, … })`, or a GET read route with `expose` (plain JSON behind a capability only). `name` is `<extension>.<verbNoun>`; methods: `GET` list/get, `POST` create and named commands, `PATCH` some fields, `PUT` the whole record, `DELETE`. Answer through an `apiOutput` projection (no undo or internal fields; instants as RFC 3339 with the family time zone's offset; all-day values as plain dates; names with `.meta({ id })`, never on a nullable schema); word requests for programs, not a model, with `omit` and `describe`. Within `v1` the shipped contract is expand-only (add operations and fields; never rename, remove or make required), and `apps/server/public-openapi.json` changes in the same pull request. Marking never changes who may run an action; `requires` and approval still decide.

## Frontend

- **Pages and forms follow [design-system.md](docs/design/design-system.md)**: one page template (no custom frames), one primary action per page, forms in a `SidePanel` (a sheet on phones), rows open on tap, secondary actions in a `⋯` menu, one filled button per view, sections are labels not boxes.
- Every page renders inside `<Page template=…>` (`@famos/ui/famos`) and never sets its own width or centring (`scripts/page-frame.test.ts`).
- **A page opens once, whole** (design-system.md 3.7): `PageGate` keeps a page invisible until its first reads finish, so load data the usual way, render an empty state only from the load that proves emptiness, and add no spinner or skeleton for the first load.
- Svelte 5 runes, TypeScript, Tailwind v4, shadcn-svelte components. Must work at phone width (~400px) and on a touch kiosk.
- **Themes are packs; style only through tokens** (`bg-surface`, `bg-idle`, `text-ink-soft`, `bg-attention` …). The token set is `packages/ui/src/theme.css`, its names and meaning in `@famos/themes` (`MODE_TOKENS`); bundled packs are in `themes/` (`pnpm theme:check <dir>`). Never hard-code colors (a test fails on them); semantic colors are never used for members. A new token needs a default in `themes/ev-isigi/tokens.json`, an entry in the token list and a line in `docs/guide/appearance.md`.
- **Styles are code**: `STYLES` in `@famos/ui` (Broadsheet, Lanes, Wall) set Today's composition and the type ramp under `[data-style]`. Other pages use the role classes in `packages/ui/src/type.css` (`type-page`, `type-record`, `type-figure`, `type-day`, `type-dateline`), never a hard-coded font or size for those roles. `accent` marks only "the next thing" (Today's hero, the calendar's next event).
- **Languages are packs** (`languages/`): code holds English only, never branches on a language code or hard-codes a locale list. Not even words to recognize input: those (command names, weekdays, units, keywords) are comma-separated catalog strings read with `ctx.vocabulary(key)` on the server (all installed languages) or `t(key)` in the UI. Prompts are English only. `scripts/language-words.test.ts` fails on non-ASCII letters in strings and regular expressions.
- **No user-facing string literals in components.** Use `t('key')` from `#lib/i18n.svelte.js` with keys in `src/messages/en.json`. An extension keeps its own catalogs (`src/messages/en.json`, `src/messages/tr.json`) and passes them as `messages` to `defineExtension` (`{ en, tr }`) and `defineWebExtension` (English); the namespace is its manifest id, and the host never imports them. The app's Turkish is `languages/tr/app.json`. Add the translation in the same change: CI fails on an incomplete bundled language or mismatched `{{placeholders}}` (`pnpm lang:check languages/tr`, `pnpm lang:check extensions/<id>`). Extensions register key types via `ResourceNamespaceMap`. Server-side text that is stored or sent (not shown through the UI) uses `ctx.translate` / `uow.translate` with a key in the extension's catalog.
- **Dates, numbers, units**: words come from the reader's language; order, numbers, hour cycle, first weekday and units from the family's region format. Dates and times use the date locale, which joins both: `app.dateLocale()` in extension UIs, `dateLocale(language, formatLocale, hourCycle)` from `@famos/time` on the server with the reader's language. Numbers and money use `app.formatLocale()` / `formatLocale` from `ctx.family.settings()`; weeks, clocks and weather use `app.weekStart()`, `app.hourCycle()`, `app.temperatureUnit()`. Never pass `app.locale()` to `Intl` or the date and money helpers, nor the format locale to a date or time formatter (a test scans for both). A date or time in a notification is a `{ date }`, `{ time }` or `{ at }` parameter, written out per recipient at delivery.
- Shared components live in `@famos/ui` (vendored shadcn-svelte, not formatted by our tools). To add one, run the shadcn-svelte CLI in a scratch SvelteKit project, copy it into `packages/ui/src/components/`, rewrite `#lib/utils.js` to `../../utils.js`, and export it. No headless-UI library (no bits-ui): write a plain Svelte 5 implementation instead.
- **Extension UI** comes only from its `./web` entry (`defineWebExtension`): nav entries, pages, slots (`dashboard.card`, `display.widget`, …), Today's timeline, facets and blocks, and draft presenters for its own actions. It never imports the app's modules: app services (translation, members, time zone, realtime events, toasts, `share()`) come from `useApp()` in `@famos/ui/app`. Slots it owns are declared in its contract (`FamosExtensionSlots`). Give `requires` to everything a family display may read, and to every page the same as its nav entry (the shell shows a "this page is for…" state; never redirect by hand). `svelte-check` typechecks it with its `tsconfig.web.json`.
- The built app contains no extension: each `./web` is built into its package and loaded by the browser at run time, taking Svelte, `@famos/ui`, `@famos/sdk`, zod, `@famos/time` and `@famos/api-client` from the app's import map (`SHARED_WEB`; anything else is bundled) and its Tailwind utilities from its own stylesheet (`ext` layer). `pnpm dev` compiles extension source with hot reload.
- **The shell never names an extension.** `apps/web/src` reaches extensions only through the registry (`contributions`, filled by `registerWebExtension`): no `/api/v1/<extension>`, no `can('<extension>.…')`, no extension's page path or route folder (`scripts/shell-agnostic.test.ts`). What the shell needs from one becomes a contribution (a facet, a block, `nav.share`, a timeline's `page`).

## Testing expectations

- Every action and route has tests using `@famos/testing` (in-memory SQLite with real migrations). Core tests use `packages/core/test/harness.ts`; extension tests use `createTestKernel` from `@famos/testing`.
- Tests never call real providers: use the scripted fake model (`k.llm.respond(...)` from `createTestKernel`).
- New adapters pass the port's contract test suite.
- Migration changes need an upgrade test from the previous release's fixture database.
- Logic gets unit tests (Vitest): layout math, selection, caching and other pure functions live in plain modules with a test beside them, not behind a browser.
- **E2E** (`apps/e2e`, Playwright): about three dozen tests of essential flows and security boundaries (setup and sign-in, roles, displays, Quick add, calendar, lists, a record page, backups, MCP, languages), under a minute. Add one only for a new essential flow or security boundary, never for layout, timing or screenshots. Each test runs the built server on its own copy of a data directory prepared once per run (migrated, admin Deniz) and starts signed in as Deniz; a test of setup or sign-in uses `test.use({ freshFamily: true })`. The fake OpenAI-compatible model is in `support/`. Once: `pnpm --filter @famos/e2e exec playwright install --only-shell chromium`. `FAMOS_E2E_LOG=1` prints the server's log (info and up) after a failing run.
- Screenshots for a UI review come from `pnpm sweep` (every page, empty and with data, day and night, 1440/1024/400, each style; narrow with `FAMOS_SWEEP_STYLES=wall`, `FAMOS_SWEEP_STATE=empty|data`). It is a review tool, not a gate.

### AI evals (Quick add and assistant)

Run by hand, not in CI: `pnpm --filter @famos/ext-inbox eval` after a Quick add prompt, mention kind (description, slots, examples) or parser change; `pnpm --filter @famos/ext-assistant eval` after an assistant prompt or tool change. Both record and replay the same way.

- **Models:** at least the two free ones the baselines hold: `FAMOS_EVAL_API_KEY=… FAMOS_EVAL_MODELS=openrouter:nvidia/nemotron-3-ultra-550b-a55b:free,openrouter:nvidia/nemotron-3.5-super-vl:free`. Paid models may be added, never required; an entry may end in `@<address>` (`ollama:qwen3:8b@http://pi.local:11434/v1`). Output: one column per model (pass/fail, tokens, cost, time, finish reason per case) and the changes against `eval/baseline.json`.
- **Workflow:** while fixing, single cases (`FAMOS_EVAL_CASE=<substring>`) on one model. Before merging a prompt, schema or tool change, one full run on both free models with `FAMOS_EVAL_RECORD=1 FAMOS_EVAL_BASELINE=1`; commit `baseline.json` and `recorded/`. No case that passed in the baseline may newly fail unless it is genuinely ambiguous and the pull request says why; an outage (provider failed) counts neither way.
- **Options:** `FAMOS_EVAL_CONCURRENCY=<n>`, `FAMOS_EVAL_MAX_COST=<usd>` (stops starting cases), `FAMOS_EVAL_REPORT=<path>` (JSON), `FAMOS_EVAL_RECORD=1` (answers to `eval/recorded/<model>/<case>.json`), `FAMOS_EVAL_RAW=1` (prints them), `FAMOS_EVAL_RUNS=<n>` (default 1; pass counts and median pass rate per model; use 3 for a baseline, as one run cannot tell flaky from broken).
- **Scoring:** a failed check is *missed* (refused, skipped, or shown as unsure) or *harmful* (a wrong value shown as certain, or a wrong thing acted on); the gate is harmful = 0. A new Quick add case says how its checks fail with the helpers in `eval/cases.ts` (`has`, `none`, `flagged`, `harmful(…)`), otherwise missed. A case may start from a household that already holds things (`fixture: 'novak'`). An assistant question case gives `expect` (days, topics, people) and is held to the card's gate in every replay.
- **Mistakes:** fix a Quick add misread in a resolver, an example or the parser, never with another prompt rule, with a test that replays the model's exact answer. Add a case to `extensions/inbox/eval/cases.ts` for every extraction mistake found in use and for each new kind; to `extensions/assistant/eval/cases.ts` for every assistant mistake found in use.
- **CI replay** (`extensions/inbox/test/golden.test.ts`, `extensions/assistant/test/golden.test.ts`): every recording runs through the real pipeline with the fake model; Quick add on the eval's household (`eval/household.ts`, with every extension `extensions.json` ships), judging a reading worth another try after the queue's retry. Each case's checks must pass, minus those the baseline lists as failing for that model; a case not yet recorded is skipped. A replay failing after a resolver or parser change is a regression: fix the code, never the recording.
- **"prompt changed":** the golden tests compare a fingerprint of everything the model is asked (Quick add: fixed rules, host examples, every kind's description, slots and examples, the answer schema; assistant: reading, wording and tool-loop prompts and every tool) with the `promptHash` in `baseline.json` and the recordings. On failure, delete the old recordings, run the full matrix with `FAMOS_EVAL_RECORD=1 FAMOS_EVAL_BASELINE=1` and commit what it writes. Never edit the hash or a recording by hand. Recordings hold only the made-up eval cases, never family data.

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

- Code, comments, commit messages and docs are in English; the UI is internationalized (English and Turkish).
- TypeScript 6, strict, with `erasableSyntaxOnly`: no enums, namespaces or parameter properties; no `any` without a comment explaining why.
- Biome formats and lints TS/JS/JSON/CSS, Prettier only `.svelte`; do not hand-format.
- Dependencies are pinned to exact versions. Before adding one, check its maintenance status and peer ranges; prefer small, low-churn packages (architecture.md, "Dependency policy").
- Commits follow Conventional Commits (`feat(shopping): …`, `fix(core): …`). Release notes are generated from them, so describe user-visible changes in user terms and mark breaking changes (`feat!:` or a `BREAKING CHANGE:` footer).
- Keep changes small and scoped to the task; do not refactor unrelated code. Prefer the simplest design that respects the rules above.
- **Comments explain themselves** and never cite documents, decision records, plans or phases; the reasons behind the rules live in architecture.md.

## Security and privacy

- PIN sign-in and the profile picker work only on trusted family devices (`core_devices`, kind `family`); never add another path that reveals member names or accepts PINs without that check. Displays (kind `kiosk`) never get PIN sign-in, profiles or write access: they hold only granted `view` capabilities and cannot run actions.
- Never log secrets, API keys, PINs or the contents of family documents.
- A credential an extension keeps (a calendar subscription URL) is sealed with `ctx.secrets` / `uow.secrets` (AES-GCM, the extension's own key derived from `FAMOS_SECRET`), never returned to the browser or logged; show a host or a hint. Provider API keys are stored encrypted in the database (key from `FAMOS_SECRET`).
- Outbound requests to addresses a user typed go through `ctx.http.get` / `ctx.http.post`, never `fetch` (SSRF guard: https only, no private/loopback/link-local addresses unless `allowLocal`, same-host redirects, size cap, timeout), and reach only what the manifest's `network` declares (`hosts`, `userUrls`, `local`). Call it from job handlers, or from a route as a bounded read-through (timeout of a few seconds, never over 15 s; size cap; answer cached so page loads do not each fetch; failure shown as `unavailable`, not an error page). Anything slow, repeated, or changing data outside is a job; `post` only runs in a job. Never inside a transaction.
- Extension code runs only from the image (trusted by place) or from the store, trusted by an ed25519 signature against `TRUST_ROOTS` (`apps/server/src/packages/trust.ts`), checked at install and at every start. Never add a setting, environment variable or unsigned path that loads package code in production.
- OAuth for AI apps: the issuer and every endpoint come from `FAMOS_BASE_URL` only, never from request headers. HTTPS is required unless an admin allowed plain http on the home network. Redirect URIs match exactly (loopback port aside). Consent is never skipped and is always for the signed-in person. Client metadata documents are fetched through the SSRF guard. Dynamic registration is off unless an admin turns it on. Tokens are opaque and stored only as hashes.
- No telemetry or calls to external services the family has not explicitly configured.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
