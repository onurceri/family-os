# Releasing

FamilyOS ships one product version as a Docker image. The version lives in `apps/server/package.json` (and `apps/web`), release notes come from Conventional Commit messages, and CI publishes on a tag.

## Versions

[SemVer](https://semver.org/), applied to what a family running FamilyOS sees:

- **Patch** (0.2.1): fixes only.
- **Minor** (0.3.0): new features; data and API change **expand-only** (AGENTS.md), so updating never needs manual steps.
- **Major** (1.0.0 → 2.0.0): anything that needs a manual step or breaks expand-only (a removed API field, a renamed column), announced in advance. Before 1.0, a minor version may do this; its notes say so under "Breaking changes".
- Pre-releases: `1.0.0-rc.1`. They get only their own image tag, never `latest`.

## Steps

1. On `main`, with CI green (the Security workflow is advice, not a gate: look at its audit, CodeQL and image-scan results and fix what it reports before a release when you can):
   ```bash
   pnpm release 0.2.0
   ```
   This sets the version (the product's and its shipped extensions'), commits `chore(release): 0.2.0`, tags `v0.2.0` and prints the notes. Nothing is pushed.
2. Read the notes. The notes are the commit messages, so fix one that reads badly before pushing (amend, or drop the tag: `git tag -d v0.2.0`).
3. Push: `git push origin main --follow-tags`.

The **Release** workflow then runs every check (lint, typecheck, tests, E2E), verifies the tag matches the version, pushes `ghcr.io/onurceri/familyos` for amd64 and arm64 as `0.2.0`, `0.2` and `latest` (plus `1` from 1.0 on), creates the GitHub release with the notes, and then publishes the extension packages (below).

## Before a release, check older browsers

Wall displays run old system browsers (Chrome 106 is the floor). CI cannot open one, so run the app in Chromium 106 by hand (needs Docker; the image is Playwright 1.26):

1. Build and start FamilyOS (`pnpm build`, then `node apps/server/dist/famos.mjs` with a throwaway `FAMOS_DATA_DIR`, `HOST=0.0.0.0`, `FAMOS_BASE_URL=http://host.docker.internal:<port>`) and set it up with an admin.
2. Run `FAMOS_URL=http://host.docker.internal:<port> FAMOS_EMAIL=<admin> FAMOS_PASSWORD=<password> scripts/old-browser/run.sh`.

It opens `/login`, `/display`, Today and a few other pages and fails on any script or console error; screenshots are written to `scripts/old-browser/screenshots`. `FAMOS_PAGES` (comma-separated paths) changes the pages visited after sign-in. Look at the screenshots too: a page can be error-free and still unpainted. `node scripts/old-browser/mixes.mjs` lists every `color-mix()` of the build with the fallback written for it (JSON).

### Page by page and color by color

Two more checks show how far an older browser is from a modern one. Both need Docker and a build, run by hand and are not part of CI.

**Pictures of every page** (`scripts/old-browser/compare/run.sh`). It starts the design sweep's sample family (members with colors, events, lists, records, weather from a fake Open-Meteo, a paired display) at a fixed time, takes full-page pictures in the repo's Chromium and in Chromium 106 (every page, Today in each style, the display; day and night; 400, 1024 and 1440 px), and compares them with pixelmatch. Once: `pnpm --filter @famos/e2e exec playwright install --only-shell chromium`. A full run takes about half an hour; `FAMOS_STYLES`, `FAMOS_ONLY` (page names) and `FAMOS_WIDTHS` narrow it. Open `test-results/old-browser/report/index.html`: pairs are ranked by changed pixels, each shown modern, 106 and diff. A shade of difference is the color check's business; look for what is not color: a different page height (named in the list), a missing or moved element, unpainted text. Those are bugs, not noise. Two different machines draw text edges a little differently, so small changes along letters are expected.

**Every mix, every theme** (`node scripts/old-browser/colors.mjs <pairs.json>`). The file lists `{ file, selector, mix, fallback }` (`colors.sample.json` shows the shape). Each pair is evaluated under the built-in tokens and under every bundled theme pack, day and night: the `color-mix()` in the repo's Chromium, the fallback in Chromium 106. It prints the pairs by ΔEOK (OKLab distance times 100), worst first, and exits 1 when one is over `FAMOS_COLORS_MAX` (2 by default, about the least a person notices) or when a fallback does not parse in Chromium 106.

## Extension packages

Every extension is also published as a signed package (`.famext`), so a family can install one the image does not carry, or a newer version, from **Settings → Extensions → Look for more** ([guide](guide/extensions.md)).

- **With the product.** The extensions the image ships (`extensions.json` `always` and `offered`) are released in lockstep: `pnpm release x.y.z` also sets `version` and `famos.version` in each of their `package.json` files. After the image is published, the Release workflow's `extensions` job (`.github/workflows/publish-extensions.yml`) builds them, packs and signs each one, attaches the `.famext` files to the GitHub release and adds them to the official index. A pre-release changes no extension version and publishes no package (a package version has no pre-release part).
- **On their own.** An extension listed as `independent` in `extensions.json` is not in the image and has its own version. To release it, set `version` and `famos.version` in its `package.json`, commit, then tag and push `ext-<id>-v<x.y.z>` (`git tag -a ext-garden-v1.0.0 -m "garden 1.0.0" && git push origin ext-garden-v1.0.0`). **Release an extension** (`release-extension.yml`) runs the checks, makes sure the tag names an independent extension at that version, and publishes it the same way, on a GitHub release of that tag. A server refuses packages built for an older SDK minor version (`SDK_VERSION`), so after a product release that changes it, release every independent extension again.
- **The official index** is on GitHub Pages, served from the `gh-pages` branch: `extensions/index.json`, its signature `extensions/index.json.sig`, and the files at `extensions/<id>/<id>-<version>.famext` (`https://onurceri.github.io/family-os/extensions/…`). Servers download from Pages, not the GitHub release, because release files redirect to another host and a server follows no redirect. The workflow keeps the newest five versions of each extension there (`--keep`, default 5; the releases keep all) and never republishes a version with other contents. Each entry of `index.json` also carries a `reach` (hosts it calls, whether it fetches typed addresses, whether it may reach the home network, how many capabilities it adds and which extensions it needs), written by `scripts/extensions.mjs index` from the package's own manifest, so a family sees it before downloading and the signature covers it; the server refuses a download whose manifest says otherwise. The index also carries `issuedAt` (epoch milliseconds, written by the same script), inside the signed bytes. A server remembers the newest `issuedAt` it accepted (in the `extension_index` settings row) and refuses an older index (`index_older`), one dated more than a day ahead of its clock (`index_future`), and an undated one once it has seen a dated one; so an old signed index cannot roll a family back. Publishing always writes a fresh date; never republish an older `index.json`. The workflow creates the branch (with `.nojekyll`) the first time. Pages must serve the `gh-pages` branch (Settings → Pages → Deploy from a branch → `gh-pages`, `/ (root)`); servers have the address built in, so a custom domain needs a release first.
- By hand: `node scripts/extensions.mjs pack [<id>…] --out <dir> --key-file <pem>` packs and signs built packages (`pnpm build` first), `node scripts/extensions.mjs index <dir> --add <file.famext>…` updates a published folder and its `index.json`, and `node scripts/extensions.mjs sign <file> --key-file <pem>` writes `<file>.sig`.

### The signing key

Packages and the index are signed with one ed25519 key. Its public half is a trust root in `apps/server/src/packages/trust.ts` (id `3bab2b9c2b26fecd`); servers accept a package or an index only when it is signed by a key listed there. Its private half (PKCS #8 PEM) exists only as the repository's Actions secret `FAMOS_EXTENSION_SIGNING_KEY`, never committed, printed or kept in a shared file. The publishing job first checks that the secret's key is a trust root (`node scripts/extension-key.mjs check --key-env FAMOS_EXTENSION_SIGNING_KEY`), so a wrong secret fails before anything is signed.

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

`main` is never rewritten, so a wrong line is corrected by a later commit of any type, whose body has the footers `Release-note-for: <at least 7 characters of the commit's sha>` and `Release-note: <type(scope): subject>`: that header replaces the earlier commit's line and lands in the section its type picks. `Release-note: none` drops the line, and when a commit has several corrections the latest wins.
