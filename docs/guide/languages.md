# Languages

English is built into FamilyOS. Every other language is a **language pack**: a folder of text files that you can add (or remove) without updating the app. Turkish is included. A string a pack does not translate shows in English, so a half-finished pack is still usable.

A language only chooses words. Dates, times, numbers and weeks follow your [region](region.md), which is a separate setting.

## Choosing a language

- **First run.** The very first setup screen is the language. It is preselected from your browser's languages; pick another and the rest of setup continues in it. It becomes the family's language and the first admin's own.
- **Family language.** **Settings → Family → Language & region**, **Family language** (you need the permission to change family settings, which admins have). It is used for people who have not chosen their own, for notifications to them, on family displays, and for the titles the AI writes for Quick add.
- **My language.** **Settings → You → Profile & sign-in**. Everyone can pick their own, or "Same as the family". The app, notifications, Telegram messages and the assistant follow it.
- **Sign-in page.** A small switcher changes the language on this device until you sign in. It appears when more than one language is available.

## Adding a pack

**Settings → Family → Language & region** lists the **Available languages**: English is **Built in**, others are **Included** or **Installed**, each with how much of the app it translates. To add one, use **Add a language**:

- **From a file.** Choose a pack as one `.json` file (see below).
- **From an address.** Enter an `https` address that returns the pack as JSON and press **Install**. FamilyOS fetches it in the background (with the same protections as other outbound requests: https only, no private addresses, a size limit). You typed the address, so this is not a call you did not configure. The page says if it could not be fetched.

Strings that cannot be used (unknown keys, mismatched `{{placeholders}}`, text longer than 4 KB) are skipped and counted on the page; the rest of the pack still works. A pack is checked against the features this FamilyOS has: one that leaves a feature out still installs (that feature shows in English, or in its own translation, and the pack's share goes down), and a pack's file for a feature you do not have is simply not used. A pack is limited to 2 MB, and up to 40 installed packs. Installing a pack with the code of an included one (for example `tr`) replaces it, so newer translations do not wait for an app release. Removing an installed pack (**Remove**, then confirm) brings the included one back. Without an included pack of that code, the family language falls back to English and people who used it follow the family language.

Installed packs are stored in `<data>/languages/<code>/` and are part of backups.

## Making a pack

A pack is a folder named after its BCP 47 code (`de`, `pt-BR`):

```
languages/de/
  manifest.json     code, name, nativeName, version, famos (compatible app versions), dir, authors
  app.json          the app's own messages (namespace "app")
  calendar.json     one file per feature (extension), named after its id; any you leave out
  ...               show in that feature's own translation if it has one, else in English
```

Features can bring their own translations with them (`extensions/<id>/src/messages/<code>.json`). Where both have a string, the pack's wins, so a pack can correct a feature's translation; where the pack has none, the feature's own is used.

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

`lang:template` fills every file with the English text, so you translate each value in place and an untranslated string reads as English meanwhile. `lang:check` on a pack counts the features' own translations of the same language too, as the app shows them, and counts how many strings are still identical to English (many are fine, such as names). Included languages must be 100% complete and valid; CI enforces it.

### Sharing a single file

To install from a file or an address, put the whole pack in one JSON document:

```json
{
  "manifest": { "code": "de", "name": "German", "nativeName": "Deutsch", "version": "1.0.0", "famos": ">=0.1.0" },
  "catalogs": { "app": { "nav_more": "Mehr" }, "calendar": { } }
}
```

To include a language with FamilyOS itself, send a pull request that adds `languages/<code>/` with `manifest.json` and `app.json`, and each feature's translation as `extensions/<id>/src/messages/<code>.json` next to its `en.json` (all must be complete; `lang:template` writes every file into the pack folder, so move the features' files over). There is no public directory of packs yet.
