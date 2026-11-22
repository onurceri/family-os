# `@famos/ui/famos`

Shared Ev Işığı components. Style only through tokens (docs/design/design-system.md). The primitives, one line of anatomy each:

- **Page**: the one page frame. `template` (`page-frame.ts`) picks a width class: `narrow` 760 px (chat, capture), `medium` 60 rem (settings), `standard` 1200 px (list, list-detail, record), `full` (day, calendar; `board` also bleeds into the gutters over a `backdrop`). Always centred (chat with an `aside`: the history pane hugs the left edge, the column centred beside it); renders the page head from `title`; a Page inside a Page adds no frame. Pages never set their own width (`scripts/page-frame.test.ts`).
- **Card**: `surface`, radius 16, 1 px line, no shadow; `lit` (shadow, no line), `quiet` (`idle`), `rows` (children divided by lines), `pad`. Never nested.
- **Row**: 48 px (56 with `meta`): leading visual, 15/600 title, 13 `ink-soft` meta, trailing content; link, button or div; `tile`, `idle`, `selected`, `done`.
- **Section**: 12/700 uppercase `ink-soft` label, plain count, ghost actions at the right, then content.
- **Segmented**: `idle` pill track, chosen option `surface` + `shadow-lit`; `radiogroup`, one tab stop, arrow keys, `sm`, `grow`.
- **Avatar**: a member's initial on their colour, or with `photo` (an address the app builds; extensions get it as `photoUrl` on `useApp().members()`) the picture, round and `object-cover`, inside a ring of their colour (2 px from 24 px up, 1 px below); a picture that fails to load falls back to the initial. `anyone` stays a neutral people icon. `resizeImage(file, side, { square: true })` cuts the centered square for a profile photo.
- **Chip**: 36 px pill; `filter` (ink ring when on), `member` (member colour ring), `preset` (outlined, adds something).
- **Pill**: 24 px 12/700 status; tinted tones are a 15 % tint with the state colour mixed toward `ink` (contrast-tested), `solid` for done.
- **IconButton**: square ghost/outline/secondary/primary at 36, `--ctl` or 44 px, required `label`, 44 px hit area.
- **EmptyState**: card of at most 420 px, the area's drawing (`art`, `EmptyArt`: 120 × 88, 1.75 px round strokes in `currentColor`, an `idle` ground, one soft `sun` accent; names in `EMPTY_ART_NAMES`) or a 52 px icon disc, 17/700 title, 14 `ink-soft` hint, primary action. `ListDetail`'s `emptyState` renders one.
- **EmptyLine**: a section with nothing yet inside a page (papers, costs, a log): a 48 px `idle` row, 18 px icon, one sentence, an optional quiet link at the end.
- **Notice**: quiet row with an 18 px tone icon (`info`, `heat`, `attention`) and one sentence.
- **Composer**: 48 px lit tile with `+`, input, `Add details` link once there is text, `Enter` adds and keeps focus, `Esc` clears; `size="lg"` is a 56 px round field for a page whose main act is adding (Shopping, Tasks).
- **Menu**: `role="menu"` popover (`shadow-pop`, 40 px items, separator before danger); arrow keys, Escape and focus return.
- **ActionSheet**: phone menu from the bottom: title, 48 px actions, Cancel row; modal, focus trapped and returned.
- **Sheet**: phone form container, full height from 12 px, grab handle, Cancel · Title · Save bar; `half` for pickers; modal, focus returned; pulling it down closes it and the page under it does not scroll.
- **Dialog**: native `<dialog>` modal, 400 px (90 % on phones), 18/800 title, actions right; focus trapped and returned.
- **Fab**: 56 px `ink` round add button above the tab bar (`--fab-bottom`) and the safe area.
- **RecordHeader**: 56 px disc, 26/800 name, one meta line of facts and avatars, actions at the right (under the name below 28 rem).
- **Facts**: card with two to four facts, 12/600 uppercase label over a 24/800 value.

**Today.** The model `today-v3.ts` is pure: `nextUp` (Family or Me), `countdown` (minutes under 60, a duration to 119, the start time from 120, "now"), `pillOf`, `memberDays`, `statusOf` (one clause), and the `Intl` formatting in the family's format locale. Components take its results and words from the caller (`NextUpWords`, `MemberDayWords`, the app's `todayWords`); sizes come from the style's ramp (`--ramp-*`), so a composition shrinks them by setting the property:

- **Clock** / **DateLine**: the time in the display face; the weekday in caps over the date (serif italic or plain).
- **WeatherBlock** with **HourlyStrip** (`tiles` or `bars`, wet hours in `info`) and the sentence; with `sky` it is a panel with **WeatherSky** behind it (`skyCondition` maps a WMO code and `isDay` to clear, partly, cloudy, fog, drizzle, rain, snow or storm; colours are srgb mixes of tokens in `sky.ts`, contrast-tested for text in every pack by `scripts/sky-contrast.test.ts`; motion is CSS `transform`/`opacity` only and stops with reduced motion or `still`; clouds, fog and snow use the `sky-cloud` and `sky-flake` tokens). `size="screen"` fills ambient mode.
- **NextUpHero** with **Countdown** (`number` or `ring`): the one `accent` surface, `on-accent` text, the inverted pill, the Family | Me toggle (only with `onmode`, never in `familyMode`); its accessible name reads "Piano lesson, 15:45, in 25 minutes".
- **MemberDay**: a person's day as a `column` (rule on top), a `stack` (rule at the side) or a `row` (ringed avatar, the next thing large).
- **FamilyList**: ringed avatar, name, one status line cut with an ellipsis (`list` or `strip`).
- **Ring** / **ChoreRings**: an arc in the member's colour with its value as text.
- **BigNumber**, **PhotoTile** (the label on the scrim in the day palette).

Member colour appears only as avatars, rings and rules, never as a surface or text.

The compositions live in the app (`apps/web/src/lib/today/`): `TodayData` loads and settles everything once (the timeline, the cards and their reports, `GET /chores/today`, `GET /ambient/photos/today`, the weather's report through `today.atmosphere`, and the hero's Family | Me through `core.setMyNextUp`), and each style's composition (`Broadsheet.svelte`, chosen by `compositions.ts`) only arranges it. `dashboard.card` contributions declared `glance` get `form: 'glance'` where a style shows the day at a glance (shopping as a `BigNumber`; chores draw nothing because the page shows the rings). Those declared `todo` (tasks) are rows a style may keep with what needs doing (Broadsheet's right column from 1280 px).

Derived constants (`--ctl` 40/44/52, `--r-ctl`, `--r-item`, `--r-card`, `--shadow-sheet`, `--sheet-scrim`) live in `../theme.css` and are not pack tokens. Components take already translated strings; none holds words of a language.
