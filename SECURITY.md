# Security policy

FamilyOS holds a family's calendar, messages, documents and the keys to their AI providers.
Security reports are taken seriously and handled before anything else.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's security advisories:
go to the repository's **Security** tab and choose **Report a vulnerability**
(https://github.com/onurceri/family-os/security/advisories/new).

Include what you found, how to reproduce it, the version or commit, and what an attacker could
do with it. You will get an answer within a week. We will keep you informed while we fix it, and
credit you in the advisory unless you prefer otherwise. Please give us a reasonable time to
release a fix before you disclose the issue publicly.

## Supported versions

FamilyOS is in beta (0.x). Security fixes go to `main` and into the next release; only the latest
release is supported, so update to it. There are no back-ported fixes for older 0.x versions.
FamilyOS has not had an independent security audit.

## In scope

- **Authentication and sessions**: sign-in, password handling, session cookies, CSRF, the
  first-run setup code, rate limits.
- **PIN sign-in and trusted devices**: the profile picker and PIN sign-in must work only on
  devices an admin marked as family devices; anything that reveals member names or accepts a PIN
  elsewhere is a vulnerability.
- **Family displays**: a paired display must only read the `view` capabilities it was granted and
  must never run an action.
- **Access control**: a member doing or seeing something their role's capabilities do not allow,
  across routes, actions, the WebSocket, search, the assistant and MCP.
- **The AI acting without approval**: any way for a model (through shared content, a prompt
  injection, the assistant or an MCP client) to change data without a person approving a draft,
  to read an area that is off for the AI, to reach a non-local provider for a "local only" area,
  or to send data outside the household.
- **SSRF**: requests to addresses a user typed (calendar subscriptions, pack installs, the
  weather) reaching private, loopback or link-local addresses without the admin allowing it.
- **Secrets**: AI provider keys, bot tokens, mail passwords, calendar subscription URLs, app keys
  and backup passphrases must never be returned to the browser, logged, or stored unencrypted.
- **Language and theme packs**: a pack is data only; any way for an installed pack to run code,
  inject CSS or HTML, or load something from another server.
- **Uploaded files and email**: stored files served unsafely, metadata (such as photo location)
  not stripped, HTML mail rendered or remote content loaded.
- **Backups**: encrypted backups that leak content, or secrets that end up inside a backup.
- **Extension packages**: any way to make the server load extension code it should not trust
  (see below), or to write outside the extension store while installing one.

## What the server trusts to run

Extensions are code that runs inside the server with the family's data, so the server runs only
code it can trust:

- **Packages shipped with the app** (`/app/extensions` in the image) are trusted by where they
  are: they come with the image you chose to run, and no setting moves that folder.
- **Packages installed from a file** (a `.famext`, kept in `/data/extensions`) are trusted only by
  their signature: an ed25519 signature over the package's `famos-package.json`, which lists the
  SHA-256 of every file in it. The server checks it against its trust roots, the public keys
  committed in `apps/server/src/packages/trust.ts`, when the file is uploaded and again at every
  start, before any of its code runs. A file that is changed, added or replaced by a link after
  signing refuses the package. Archives are read with strict limits (20 MB compressed, 60 MB
  unpacked, 2000 files), regular files only, and no path that leaves the package.
- **Today there is no trust root**: the project's release key is added when the first signed
  packages are published, so until then every package from a file is refused. Only the FamilyOS
  project's own key will be trusted at first; there is no setting or environment variable that
  adds a key. Installing needs an admin who is signed in (never an API token, an agent or the AI).
- **Workspace source** (`FAMOS_DEV_EXTENSIONS`) is for development only, unsigned, and refused when
  `NODE_ENV=production`.

## Out of scope

- Attacks that need an admin account or physical access to the server.
- Running FamilyOS over plain HTTP on an untrusted network; use HTTPS (see the
  [guide](docs/guide/https.md)).
- What a family chooses to send to a cloud AI provider; the provider's own handling of it.
- Denial of service through large volumes of traffic.
- Vulnerabilities in dependencies without a way to exploit them in FamilyOS (please still tell
  us, through a normal issue, if an update is needed).
