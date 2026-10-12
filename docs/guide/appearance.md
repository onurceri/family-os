# Appearance

How FamilyOS looks is two choices: a **style** and a **theme** (the colors).

- The **style** decides how **Today** and the **family displays** are arranged, and the type everywhere: the size of page titles, the faces of the clock and the big numbers, the date line. There are three: **Broadsheet**, **Lanes** and **Wall**. Styles come with FamilyOS; you cannot install one.
- The **theme** is the palette: colors, the rounding of corners and the typefaces it prefers. Six themes are included, and you can add more (below).

Any style works with any theme. Light, dark or "follow my device" is a third, separate choice that each device makes for itself; every theme has a day and a night look. Family displays follow the sun.

## The styles

| Style | Today |
|---|---|
| **Broadsheet** (the default) | Three voices: a condensed clock and numbers, a serif date and title, plain text for the rest. On a wide screen three columns: the clock, the weather, a photo, where everyone is and the chores as rings; the day, with a column per person; what needs doing, with what needs you, shopping as a number and the tasks. |
| **Lanes** | The day as a chart: one time line from morning to night with the hourly weather on it, a lane per person and one for the family, each thing drawn where it happens, a line for now. The next thing is a departure board with what comes **Then**. |
| **Wall** | One typeface at a large size: a big clock and temperature, the next thing with a countdown ring, **Who, next** as a row per person with their chores as a ring, and three tiles (shopping, what is ahead, the kitchen). |

On a phone every style stacks into one column and nothing scrolls sideways; Lanes turns its chart upright, with a column per person (at most five, then **Others**). Other pages (lists, the calendar, records, settings) keep their layout in every style and take only its type, and the calendar marks today's next event with the theme's accent color.

## The included themes

| Theme | Character |
|---|---|
| **Ev Işığı** | The default: warm wall, bright cards, calm. |
| **Coast** | Cool blue-grey, crisp. |
| **Forest** | Soft greens, quiet. |
| **Plum** | Muted violet, cosy at night. |
| **Paper** | Black on white; color only for state. |
| **High contrast** | Very strong contrast (AAA for text) in both palettes, with outlined cards. For low vision and bright rooms. |

## Choosing

**Settings → You → Appearance** shows the **Style** first, as three live pictures of Today on a made-up day in the colors you use, then the **Colors**: day or night on this device, a sample of the real parts of FamilyOS, and every theme as a small picture (day colors next to night colors). What you use on this device is marked **In use**.

- **For yourself:** **Use for me** on a style or a theme. It follows you to every device you sign in on. **Use the family style** (shown while you have your own) takes it back.
- **For the family:** **Settings → Family → Theme** (admins, and anyone allowed to change family settings). **Family style** and **Make family default** on a theme set what everyone sees who has not chosen their own, and the sign-in page.
- **For a display:** the same page lists the **Displays**, each with its own **Style** and **Theme** (or **Same as the family**).

A theme may suggest a style. The suggestion is used only while the family has never chosen a style; **Family style** then says which theme suggests it. Otherwise the order is: the display's own, then the person's own, then the family's, then the theme's suggestion, then Broadsheet.

Changes show on open screens within a moment, without a reload.

### What Today shows

Under the style, **What Today shows** lists every part of Today (the time and date, the sentence, the weather, the photo, next up, the rest of the day, where everyone is, chores, Needs you, meals, the next days, done today, and the cards of each feature such as the board, tasks, shopping, coming up and Ask the assistant), each with a switch. Turn off what you do not need: the part is simply not there, and your style arranges what is left (a column with nothing left gives its room to the others). It is show or hide only; the order stays the style's.

- **For yourself:** **Follow the family** or **My own choice**, like the style. Changing a switch makes the choice your own. On Today, the **⋯** at the end of a section's label offers **Hide from Today**, with **Undo**.
- **For the family:** **Settings → Family → Theme**, **What Today shows**: what everyone sees who has not made their own choice.
- **For a display:** the same page, under each display, **What Today shows** (or **Same as the family**). The display still leaves out what does not fit its screen.

Hiding **Needs you** never hides what waits for approval: Quick add still shows its count, and notifications still come. If everything is hidden, Today says so and offers **Choose what Today shows**. A part added later (a new feature) is shown until someone hides it.

### Trying a look

**Try** shows a style or a theme on the whole app without choosing it. Trying a style opens Today, where it shows most; trying a theme recolors the page at once. You can try a style and a theme together.

While you try, a bar at the foot of every page says what you are trying ("Trying Lanes · Forest") with:

- **Use for me**: keeps what you are trying as your own choice;
- **Keep looking**: back to Appearance;
- **Stop**: back to what you had.

Trying is only on this screen and only for now: it also ends when you sign out, when someone else signs in, or when the page is reloaded. Nobody else sees it.

## Adding a theme

On **Settings → Family → Theme**, with **Add a theme** (family settings permission required):

- **From a file.** Choose a theme pack as one `.json` file (see below).
- **From an address.** Enter an `https` address that returns the pack as JSON. FamilyOS fetches it in the background with the same protections as other outbound requests (https only, no private addresses, a size limit). You typed the address, so this is not a call you did not configure.

A pack that is not valid is refused, and the page lists why, for example `Contrast: ink on wall (day) is 1.6:1, needs 4.5:1`. Installing a pack with the id of an included theme replaces it; removing it brings the included one back. People and displays that used a removed theme fall back to the family default. Installed packs are stored in `<data>/themes/<id>/` and are part of [backups](backups.md).

A theme is data, never code: there is no CSS, script or image in a pack. The server writes the stylesheet itself from the validated values, so a pack cannot hide a warning, load something from another server or make text unreadable.

## Making your own theme

A pack is a folder named after its id (`my-theme`):

```
themes/my-theme/
  manifest.json     id, name, version, famos (compatible app versions), authors, fonts, style
  tokens.json       the values: day, night, radius, font, font-display, font-serif
  my-font.woff2     optional font files
```

`manifest.json`:

```json
{
  "id": "my-theme",
  "name": "My theme",
  "version": "1.0.0",
  "famos": ">=0.1.0",
  "authors": ["Your name"]
}
```

A manifest may also name `"style"`: `"broadsheet"`, `"lanes"` or `"wall"`, the style the theme suggests while the family has not chosen one. An unknown style is reported and ignored.

`tokens.json` sets the tokens below separately for the `day` and the `night` palette. Colors may be written as `#rrggbb` (also `#rgb`), `rgb(30 28 26)` or `oklch(0.3 0.01 80)`, and are checked and converted to sRGB. **Anything you leave out is taken from Ev Işığı**, so a small theme can set just a few colors.

| Token | Meaning |
|---|---|
| `wall` | The page behind everything. |
| `surface` | Cards and anything raised above the wall: active, important things. |
| `idle` | Things that recede: inactive rows, chips and fields. |
| `ink` | Body text and icons. |
| `ink-soft` | Secondary text: hints, captions, labels. |
| `line` | Borders and dividers. |
| `attention` | State: something needs a person (waiting suggestions, warnings, badges). |
| `now` | State: now, done, healthy. |
| `sun` | State: soon, highlighted, a pending or neutral highlight. |
| `info` | State: information and focus rings. |
| `heat` | State: high, hot, urgent but not blocking. |
| `on-color` | Text and icons on the state colors `attention`, `now` and `info` (badges, buttons, check marks). Member initials and text over photos always use the day value, so a night value that is dark does not affect them. |
| `destructive` | Deleting and other destructive actions. |
| `accent` | The one saturated surface a page may have: the next-up hero on Today, and nothing else. Never used for text. A pack that wants no accent sets it to its `ink`. |
| `on-accent` | Text and icons on `accent`; the pill on the hero is filled with it and carries `accent` text. |
| `scrim` | Darkens photos under text (family displays). May be transparent. |
| `backdrop` | Behind full-screen photos and ambient mode. |
| `shadow-lit` | The soft shadow lifting cards off the wall. |
| `board` | The family board: the surface behind the notes. Text on it uses `ink` and `ink-soft`, so both must read on it. |
| `board-grain` | The board's texture (cork flecks, felt, lines), drawn over `board`. May be transparent. |
| `note-1` | Board notes: the first paper (the author picks one of five). |
| `note-2` | Board notes: the second paper. |
| `note-3` | Board notes: the third paper. |
| `note-4` | Board notes: the fourth paper. |
| `note-5` | Board notes: the fifth paper. |
| `note-ink` | Text on the note papers. |
| `note-ink-soft` | Secondary text on the note papers: the time, "until Friday", who has seen it. |
| `note-tape` | The strip of tape on a pinned note. May be transparent. |
| `sky-cloud` | The weather sky: clouds and fog banks, over the sky behind text. Light in both palettes; keep it faint at night. May be transparent. |
| `sky-flake` | The weather sky: snowflakes. Light in both palettes. |

The board and its notes (see [The family board](board.md)): `note-ink` and `note-ink-soft` must reach 4.5:1 on each of the five papers, and `ink` and `ink-soft` must reach 4.5:1 on `board`. Notes are papers the author picks, so make the five clearly different from each other and still recognisably paper; at night, make them softly lit paper (the bundled packs sit at OKLCH lightness 0.50 with the day hue), not mud and not glow.

Four more tokens are set once, beside `day` and `night`:

| Token | Meaning |
|---|---|
| `radius` | Corner rounding of items, `0` to `2rem` (`0.75rem`, `12px`); cards and chips scale from it. |
| `font` | The body font: `"Figtree"` (bundled, the default), `"Archivo"` (bundled), `"system"` (the device's own font), or a family your pack ships. |
| `font-display` | The display face: the clock, countdowns, big numbers and tracked caps labels. A bundled family (below) or one your pack ships; `""` or left out means the style's own choice. |
| `font-serif` | The serif: the date, the hero title and the weather sentence. A bundled family or one your pack ships; `""` or left out means the style's own choice. |

Only these tokens exist; unknown ones are ignored and reported. Shadows are up to four layers of `x y blur spread color` (`0 1px 2px rgb(0 0 0 / 0.1)`) or `none`.

Example `tokens.json`:

```json
{
  "day": { "wall": "#e8efe6", "surface": "#fbfdf9", "ink": "#16241a", "ink-soft": "#44564a" },
  "night": { "wall": "#111a14", "surface": "#1c2920", "ink": "#eef6ef", "ink-soft": "#b3c4b8" },
  "radius": "1rem"
}
```

### The contrast rule

A pack is checked on install, in both palettes, against WCAG 2.2. For every pair that your pack changes:

- `ink` and `ink-soft` on `wall`, `surface` and `idle`: at least **4.5 : 1** (AA for text).
- `on-color` on `attention`, `now` and `info`: at least **4.5 : 1**. Every bundled pack uses a dark `on-color` at night, because the night state colors are light.
- `on-accent` on `accent`: at least **4.5 : 1**. The pill on the hero uses the same pair the other way round. `accent` is never text, so it has no rule against `wall` or `surface`: a warm accent on a pale wall is fine.
- `attention`, `now`, `info` and `destructive` as text (error and status messages, links) on `wall` and `surface`: at least **4.5 : 1**.

`sun` and `heat` only color icons next to a text label, and nothing writes on them, so they have no rule. The bundled packs pass every rule.

Pairs you did not touch keep what Ev Işığı gives them. State colors work best when they stay different from each other in hue as well as lightness; **High contrast** is a good model (aim for 7 : 1 for AAA).

### Fonts

FamilyOS bundles four families and serves them from its own address; nothing loads from another server. Each ships only its latin and latin-ext subsets (Turkish and the other latin-script languages included); text in other scripts uses the device's fonts.

| Family | Name in `tokens.json` | Weights | Licence | Package |
|---|---|---|---|---|
| Figtree | `"Figtree"` | 300–900 (variable) | SIL Open Font Licence 1.1 | `@fontsource-variable/figtree` 5.3.0 |
| Barlow Condensed | `"Barlow Condensed"` | 500, 600, 700 | SIL Open Font Licence 1.1 | `@fontsource/barlow-condensed` 5.3.0 |
| Instrument Serif | `"Instrument Serif"` | 400, upright and italic | SIL Open Font Licence 1.1 | `@fontsource/instrument-serif` 5.3.0 |
| Archivo | `"Archivo"` | 100–900, width 62–125 % (variable) | SIL Open Font Licence 1.1 | `@fontsource-variable/archivo` 5.3.0 |

`font` takes Figtree, Archivo or `system`; the condensed and serif faces are not for running text. `font-display` and `font-serif` take any of them. A family that is neither bundled nor in your pack is reported and the style's own choice is used, so the pack still loads. The display faces (Barlow Condensed, Archivo, and a display face your pack ships) wait briefly for their file instead of showing a fallback, so a clock never changes shape.

Ship a font as a `.woff2` file of at most 400 KB (eight files, 1.5 MB for the whole pack), and name it in the manifest:

```json
"fonts": { "My Sans": [{ "file": "my-sans.woff2", "weight": "100 900" }] }
```

then set `"font": "My Sans"` (or `font-display`, `font-serif`) in `tokens.json`. Fonts are served from your own FamilyOS, never from another server. Only WOFF2 is accepted. Check the font's license allows it.

### Checking and installing

```bash
pnpm theme:check themes/my-theme
```

prints what is wrong, or `OK`. To install a pack from a folder, put it into one JSON file with the fonts as base64 text:

```json
{
  "manifest": { "id": "my-theme", "name": "My theme", "version": "1.0.0", "famos": ">=0.1.0" },
  "tokens": { "day": {}, "night": {} },
  "fonts": { "my-sans.woff2": "<base64>" }
}
```

and add it from **Settings → Family → Theme → Add a theme → From a file**, or host the same JSON at an `https` address. To ship a theme with the app, put the folder into `themes/` in the repository.
