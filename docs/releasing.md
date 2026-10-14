# Releasing

FamilyOS ships one product version as a Docker image. There is no release library: the version lives in `apps/server/package.json` (and `apps/web`), release notes come from Conventional Commit messages, and CI publishes on a tag.

## Versions

[SemVer](https://semver.org/), applied to what a family running FamilyOS sees:

- **Patch** (0.2.1): fixes only.
- **Minor** (0.3.0): new features; data and API change **expand-only** (AGENTS.md), so updating never needs manual steps.
- **Major** (1.0.0 → 2.0.0): anything that needs a manual step or breaks expand-only (a removed API field, a renamed column), announced in advance. Before 1.0, a minor version may do this; its notes say so under "Breaking changes".
- Pre-releases: `1.0.0-rc.1`. They get only their own image tag, never `latest`.

## Steps

1. On `main`, with CI green:
   ```bash
   pnpm release 0.2.0
   ```
   This sets the version, commits `chore(release): 0.2.0`, tags `v0.2.0` and prints the notes. Nothing is pushed.
2. Read the notes. If a commit message reads badly, fix it before pushing (amend or drop the tag: `git tag -d v0.2.0`), because the notes are generated from the messages.
3. Push: `git push origin main --follow-tags`.

The **Release** workflow then runs every check (lint, typecheck, tests, E2E), verifies the tag matches the version, pushes `ghcr.io/onurceri/familyos` for amd64 and arm64 as `0.2.0`, `0.2` and `latest` (plus `1` from 1.0 on), and creates the GitHub release with the notes.

## Notes

`node scripts/release-notes.mjs <version> [from] [to]` prints the notes for any range (by default since the previous `v*` tag). Sections:

| Section | From |
|---|---|
| Breaking changes | `feat!:`, `fix!:` or a `BREAKING CHANGE:` footer |
| New | `feat` |
| Fixed | `fix` |
| Security | `fix(security)` |
| Faster | `perf` |

Docs, tests, refactors, CI and chores are left out, so write `feat` and `fix` subjects for the people who use FamilyOS.

`main` is never rewritten, so a line that reads wrongly is corrected by a later commit of any type. Give its body the footers `Release-note-for: <at least 7 characters of the commit's sha>` and `Release-note: <type(scope): subject>`: that header replaces the earlier commit's line and lands in the section its type picks. `Release-note: none` drops the line, and when a commit has several corrections the latest wins.
