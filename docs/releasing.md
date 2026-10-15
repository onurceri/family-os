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
   This sets the version (of the product and of the extensions it ships), commits `chore(release): 0.2.0`, tags `v0.2.0` and prints the notes. Nothing is pushed.
2. Read the notes. If a commit message reads badly, fix it before pushing (amend or drop the tag: `git tag -d v0.2.0`), because the notes are generated from the messages.
3. Push: `git push origin main --follow-tags`.

The **Release** workflow then runs every check (lint, typecheck, tests, E2E), verifies the tag matches the version, pushes `ghcr.io/onurceri/familyos` for amd64 and arm64 as `0.2.0`, `0.2` and `latest` (plus `1` from 1.0 on), creates the GitHub release with the notes, and then publishes the extension packages (below).

## Extension packages

Every extension is also published as a signed package (`.famext`), so a family can install one the image does not carry, or a newer version, from **Settings → Extensions → Look for more** ([guide](guide/extensions.md)).

- **With the product.** The extensions the image ships (`extensions.json` `always` and `offered`) are released in lockstep: `pnpm release x.y.z` also sets `version` and `famos.version` in each of their `package.json` files. After the image is published, the Release workflow's `extensions` job (`.github/workflows/publish-extensions.yml`) builds them, packs and signs each one, attaches the `.famext` files to the GitHub release and adds them to the official index. A pre-release changes no extension version and publishes no package (a package version has no pre-release part).
- **On their own.** An extension listed as `independent` in `extensions.json` is not in the image and has its own version. To release it, set `version` and `famos.version` in its `package.json`, commit, then tag and push `ext-<id>-v<x.y.z>` (`git tag -a ext-garden-v1.0.0 -m "garden 1.0.0" && git push origin ext-garden-v1.0.0`). **Release an extension** (`release-extension.yml`) runs the checks, makes sure the tag names an independent extension at that version, and publishes it the same way, on a GitHub release of that tag. When the SDK's minor version changes (`SDK_VERSION`, the platform packages are built for), a server refuses packages built for the old one, so release every independent extension again after such a product release.
- **The official index** is on GitHub Pages, served from the `gh-pages` branch: `extensions/index.json`, its signature `extensions/index.json.sig`, and the files at `extensions/<id>/<id>-<version>.famext` (`https://onurceri.github.io/family-os/extensions/…`). Servers download from Pages, not from the GitHub release, because release files redirect to another host and a server follows no redirect. The workflow keeps the newest five versions of each extension there (the releases keep all), and never publishes a version again with other contents. It creates the branch (with `.nojekyll`) the first time. Pages must serve the `gh-pages` branch (Settings → Pages → Deploy from a branch → `gh-pages`, `/ (root)`); a custom domain would move the address, which servers have built in, so it needs a release first.
- By hand: `node scripts/extensions.mjs pack [<id>…] --out <dir> --key-file <pem>` packs and signs built packages (`pnpm build` first), `node scripts/extensions.mjs index <dir> --add <file.famext>…` updates a published folder and its `index.json`, and `node scripts/extensions.mjs sign <file> --key-file <pem>` writes `<file>.sig`.

### The signing key

Packages and the index are signed with one ed25519 key. Its public half is a trust root in `apps/server/src/packages/trust.ts` (id `3bab2b9c2b26fecd`); servers accept a package or an index only when it is signed by a key listed there. Its private half (PKCS #8 PEM) is only the repository's Actions secret `FAMOS_EXTENSION_SIGNING_KEY`. It is never committed, printed or kept in a file anyone shares; the publishing job first checks that the secret's key is a trust root (`node scripts/extension-key.mjs check --key-env FAMOS_EXTENSION_SIGNING_KEY`), so a wrong secret fails before anything is signed.

**Rotating it** (because it may have leaked, or as a precaution):

1. `node scripts/extension-key.mjs generate --out new-key.pem` writes the new private key (mode 600, never overwritten) and prints its trust root.
2. Add that trust root to `TRUST_ROOTS` beside the old one, and release FamilyOS with both. Wait until families have updated: a server only trusts keys it knows.
3. Replace the secret with the contents of `new-key.pem` (`gh secret set FAMOS_EXTENSION_SIGNING_KEY < new-key.pem`), then delete the file. The next release signs packages and the index with the new key; packages the old key signed keep working on servers that list both.
4. In a later release, remove the old trust root. Packages it signed (installed ones are checked at every start) are then refused, so republish what families still need first. After a leak, skip the wait: remove the old key in the same release that adds the new one, and say so in the notes.

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
