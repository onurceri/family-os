## What and why

<!-- What this changes, for whom, and the issue it closes (Closes #…). -->

## How it was tested

<!-- Tests added or changed; for UI, the widths and day/night you looked at. -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck` and `pnpm test` pass
- [ ] The title follows Conventional Commits (`feat(calendar): …`, `fix(core): …`) and describes the change for the people who use FamilyOS; breaking changes are marked (`feat!:`)
- [ ] It follows [AGENTS.md](../AGENTS.md); a rule that changes is updated in `docs/architecture.md` too
- [ ] Routes changed: `openapi.json`, `packages/api-client` and the extensions' API types regenerated with `pnpm gen`
- [ ] Migrations: a new, hand-written, expand-only migration (no released migration edited) with its table types
- [ ] New strings: English in `en.json`, and Turkish updated (`languages/tr/app.json`, or the extension's own `src/messages/tr.json`)
- [ ] UI: follows the [design system](../docs/design/design-system.md), tokens only, works at phone width
- [ ] User-visible behaviour: the [user guide](../docs/guide/README.md) is updated
