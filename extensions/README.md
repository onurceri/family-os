# Extensions

Each feature (calendar, lists, Quick add, the board, records, …) is one package here. See
[docs/architecture.md](../docs/architecture.md) §4–7 for the contract and the reasons behind the
boundaries, and [AGENTS.md](../AGENTS.md) for the checklist.

```
extensions/<id>/
├── package.json        # exports "./contract", "./server", "./web"; the manifest in "famos"
└── src/
    ├── contract/       # Zod schemas, route + action + event types — importable by anyone
    ├── server/         # actions, routes, jobs, migrations, queries — imported by apps/server only
    └── web/            # Svelte pages, widgets, draft renderers — imported by apps/web only
```

Rules (enforced by `.dependency-cruiser.cjs`): import only `@famos/sdk`, `@famos/ui` and other
extensions' `./contract`; no foreign keys into other extensions' tables; talk to other extensions
through actions, events and typed IDs.
