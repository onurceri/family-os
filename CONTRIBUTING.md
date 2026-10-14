# Contributing to FamilyOS

Thank you for helping. FamilyOS is a family organizer that people run at home, so the bar is:
it keeps working, it keeps the family's data safe, and it stays small enough to maintain.

## Before you start

- **Bugs**: open an issue with the bug report form. Security problems are different: report them
  privately (see [SECURITY.md](SECURITY.md)).
- **Features**: open an issue with the feature request form and describe the family situation it
  helps with before writing code. A short discussion first saves a rewrite later.
- **Small fixes** (typos, docs, an obvious bug) can go straight to a pull request.

## Set up

Requirements: Node.js 24 or later and pnpm 12. The pnpm version is pinned in `package.json`;
run `corepack enable`, or use `npx pnpm@12.9.1` in place of `pnpm`.

```bash
pnpm install
pnpm dev          # API on :3000 and web on :5173 (proxies /api)
```

Open http://localhost:5173 and follow the setup link printed by the server.

## Check your change

Run these before you open a pull request; CI runs the same:

```bash
pnpm lint         # Biome, Prettier (.svelte), dependency-cruiser
pnpm typecheck
pnpm test         # unit and integration tests on in-memory SQLite
```

- Every action and route has tests (`createTestKernel` from `@famos/testing`). Tests never call a
  real AI provider; use the scripted fake model.
- After changing routes, run `pnpm gen` and commit `openapi.json` and `packages/api-client`.
  Never edit generated files by hand.
- `pnpm e2e` runs the small set of end-to-end flows in Playwright (run
  `pnpm --filter @famos/e2e exec playwright install --only-shell chromium` once). Add an e2e test
  only for a new essential flow or security boundary.
- For UI changes, look at the page at phone width (~400 px) and on a wide screen, by day and by
  night. `pnpm sweep` takes screenshots of every page.

## The rules, in brief

[AGENTS.md](AGENTS.md) is the checklist (for people and for AI coding agents), and
[docs/architecture.md](docs/architecture.md) explains each rule and why it exists. The most
important ones:

- **Extensions never import each other's internals.** They talk through actions, events and
  typed ids; tables are prefixed with the extension id. dependency-cruiser enforces the
  boundaries.
- **Every state change is an action** (`defineAction`); permissions and approval are enforced by
  the action runner, not in route handlers.
- **Access is capabilities, never role names.** Never assume a household shape.
- **AI does not change data directly.** What the AI proposes becomes a draft a person approves.
  Model calls run only in background jobs.
- **Migrations are hand-written, forward-only and expand-only.** Never edit a released migration.
- **Region-neutral and language-neutral.** No country-specific presets or defaults; English only
  in code, other languages as packs; dates and numbers use the family's region format.
- **Style only through tokens**, and follow the [design system](docs/design/design-system.md).
- **Comments explain themselves** and never cite documents, plans or decision records.

A change to a rule is welcome when it is deliberate: open an issue first, and update
architecture.md and AGENTS.md in the same pull request.

## Pull requests

- **Keep them small** and about one thing. Do not refactor unrelated code in the same change.
- **Commits follow [Conventional Commits](https://www.conventionalcommits.org/)**:
  `feat(calendar): …`, `fix(core): …`, `docs: …`. Release notes are generated from `feat` and
  `fix` messages, so write them for the people who use FamilyOS, and mark breaking changes with
  `feat!:` or a `BREAKING CHANGE:` footer.
- Dependencies are pinned to exact versions. Explain why a new dependency is needed and check its
  maintenance; small, low-churn packages are preferred.
- Describe what you tested in the pull request.

By contributing you agree that your contribution is licensed under the project's license,
[AGPL-3.0-or-later](LICENSE).

## Good first contributions

- **A language pack.** Translate FamilyOS into your language without touching code:
  `pnpm lang:template <code>` writes a pack from the English catalogs, `pnpm lang:check <dir>`
  reports what is missing. See [Languages](docs/guide/languages.md). A bundled language must be
  complete: the app's strings in `languages/<code>/app.json`, each extension's in its own
  `src/messages/<code>.json`.
- **A theme pack.** A palette is a `tokens.json` of colour values (and optional fonts), checked
  for contrast with `pnpm theme:check <dir>`. See [Appearance](docs/guide/appearance.md).
- **The user guide.** If something in [docs/guide](docs/guide/README.md) was unclear when you set
  FamilyOS up, a pull request that makes it clearer helps the next family.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind; families of every
shape use this.
