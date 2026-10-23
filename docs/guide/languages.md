# Languages

English is built in. Every other language is a **language pack**: text files you add or remove without an app update. Turkish is included. Untranslated strings show in English. A language chooses words only; dates, numbers and weeks follow your [region](region.md).

## Choosing a language

| Where | What it sets |
|---|---|
| **First run** | First setup screen, preselected from your browser. Becomes the family's and the first admin's language. |
| **Settings → Family → Language & region → Family language** | People without their own, their notifications, displays, and Quick add titles the AI writes. Needs permission to change family settings. |
| **Settings → You → Profile & sign-in** | Your own, or "Same as the family": the app, notifications, Telegram and the assistant. |
| **Sign-in page** | A switcher for this device until you sign in, when more than one language exists. |

## Adding a pack

**Settings → Family → Language & region** lists **Available languages**: English is **Built in**, others **Included** or **Installed**, with how much each translates. Under **Add a language**:

- **From a file.** Choose a pack as one `.json` file (below).
- **From an address.** Enter an `https` address returning the pack as JSON, press **Install**. Fetched in the background (https only, no private addresses, size limit); the page says if it fails.

**Remove**, then confirm, removes an installed pack.

**Good to know**
- Unusable strings (unknown keys, mismatched `{{placeholders}}`, text over 4 KB) are skipped and counted.
- A pack missing a feature still installs; that feature shows in English or its own translation. Files for features you lack are ignored.
- Limits: 2 MB per pack, 40 installed packs.
- A pack with an included code (`tr`) replaces it; removing it brings the included one back. With none included, the family falls back to English and people who used it follow the family language.
- Stored in `<data>/languages/<code>/`, part of backups.

## Making a pack

A pack is a folder named after its BCP 47 code (`de`, `pt-BR`):

```
languages/de/
  manifest.json     code, name, nativeName, version, famos (compatible app versions), dir, authors
  app.json          the app's own messages (namespace "app")
  calendar.json     one file per feature (extension), named after its id; any you leave out
  ...               show in that feature's own translation if it has one, else in English
```

Features bring their own translations (`extensions/<id>/src/messages/<code>.json`). Where both have a string, the pack's wins; where the pack has none, the feature's own is used.

`manifest.json`:

```json
{
  "code": "de",
  "name": "German",
  "nativeName": "Deutsch",
  "version": "1.0.0",
  "famos": ">=0.1.0",
  "authors": ["Your name"]
}
```

`dir` is `ltr` or `rtl` and is worked out from the language when left out. `famos` is a semver range such as `>=0.1.0` or `^1.2.0`.

Each catalog has the same keys as the English one (`apps/web/src/messages/en.json`, `extensions/<id>/src/messages/en.json`). Keep the `{{placeholders}}` exactly as in English: `"Hello, {{name}}"` becomes `"Hallo, {{name}}"`. Plurals use the language's own forms (`Intl.PluralRules`): English has `items_one` and `items_other`; Arabic would add `items_zero`, `items_two`, `items_few`, `items_many`; Japanese needs only `items_other`. There is no HTML in catalogs; strings are shown as text.

### Tools

```bash
pnpm lang:template de        # writes languages/de/ from the English catalogs
pnpm lang:check languages/de # coverage, unknown keys, placeholder mismatches (non-zero on problems)
pnpm lang:check languages/de --complete   # also fails when strings are missing
pnpm lang:check extensions/calendar       # the translations one feature ships
```

`lang:template` fills every file with the English text, so you translate each value in place. `lang:check` on a pack counts the features' own translations of the same language too, and how many strings are still identical to English (many are fine, such as names). Included languages must be 100% complete and valid; CI enforces it.

### Sharing a single file

To install from a file or an address, put the whole pack in one JSON document:

```json
{
  "manifest": { "code": "de", "name": "German", "nativeName": "Deutsch", "version": "1.0.0", "famos": ">=0.1.0" },
  "catalogs": { "app": { "nav_more": "Mehr" }, "calendar": { } }
}
```

To include a language with FamilyOS itself, send a pull request that adds `languages/<code>/` with `manifest.json` and `app.json`, and each feature's translation as `extensions/<id>/src/messages/<code>.json` next to its `en.json` (all must be complete; `lang:template` writes every file into the pack folder, so move the features' files over). There is no public directory of packs yet.
