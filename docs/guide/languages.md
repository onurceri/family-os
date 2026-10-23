# Languages

English is built into FamilyOS. Every other language is a **language pack**: a folder of text files you can add or remove without updating the app. Turkish is included. A string a pack does not translate shows in English, so a half-finished pack is still usable.

A language only chooses words. Dates, times, numbers and weeks follow your [region](region.md), a separate setting.

## Choosing a language

| Where | What it sets |
|---|---|
| **First run** | The first setup screen is the language, preselected from your browser's languages. It becomes the family's language and the first admin's own. |
| **Settings → Family → Language & region → Family language** | For people who have not chosen their own, notifications to them, family displays, and the titles the AI writes for Quick add. Needs the permission to change family settings (admins have it). |
| **Settings → You → Profile & sign-in** | Your own, or "Same as the family". The app, notifications, Telegram messages and the assistant follow it. |
| **Sign-in page** | A small switcher changes the language on this device until you sign in. Shown when more than one language is available. |

## Adding a pack

**Settings → Family → Language & region** lists the **Available languages**: English is **Built in**, others are **Included** or **Installed**, each with how much of the app it translates. Under **Add a language**:

- **From a file.** Choose a pack as one `.json` file (see below).
- **From an address.** Enter an `https` address that returns the pack as JSON and press **Install**. FamilyOS fetches it in the background (https only, no private addresses, a size limit). The page says if it could not be fetched.

To remove an installed pack press **Remove**, then confirm.

**Good to know**
- Strings that cannot be used (unknown keys, mismatched `{{placeholders}}`, text longer than 4 KB) are skipped and counted on the page; the rest still works.
- A pack that leaves a feature out still installs: that feature shows in English, or in its own translation, and the pack's share goes down. A file for a feature you do not have is not used.
- Limits: 2 MB per pack, up to 40 installed packs.
- A pack with the code of an included one (for example `tr`) replaces it, so newer translations do not wait for an app release. Removing it brings the included one back.
- Without an included pack of that code, the family language falls back to English and people who used it follow the family language.
- Installed packs are stored in `<data>/languages/<code>/` and are part of backups.

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
