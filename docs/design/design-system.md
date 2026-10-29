# Design system

How FamilyOS looks and behaves: page templates, components, the rules for adding and editing, settings, type and tokens. Every page in the app and in extensions follows it. The default look, **Ev Işığı** ("home light"), treats the screen as a lit wall: idle things recede into the wall, and whatever is active or needs someone becomes a bright card, calm enough for a kitchen and clear enough for children. The look is a **style** (how Today and the family display are arranged, and the type) plus a **palette** (a theme pack of token values); see [architecture §6](../architecture.md#appearance-styles-and-palettes) and the [appearance guide](../guide/appearance.md).

## 1. Principles

1. **Lit is rare; saturated is once.** A shadow means *this is the one*: the next event, the thing that needs you, the selected item, a focused composer. Containers are not lit; a page that lifts everything lifts nothing. A page has at most **one accent surface** (`accent` with `on-accent` text at full opacity): on Today, the next-up hero; elsewhere `accent` only marks "the next thing" (the calendar's next event) and never fills a surface. `accent` is never text.
2. **Three surfaces, never nested.** The wall holds *tiles* (surface, lit, standalone rows) and *quiet rows* (idle); a *card* (surface, 1 px line, no shadow) holds rows divided by lines. A card never contains a card; a column never gets a frame.
3. **One way to add, one way to edit.** One primary action per page, in one place; forms open in a side panel on wide windows and a sheet on phones; rows open on tap; secondary actions live in a `⋯` menu. Nothing is "always open".
4. **Sections are labels, not boxes.** A section is an uppercase label on the wall with its count and actions; its content is rows. An empty section is one quiet line that says so and offers the action.
5. **State is said once.** A due date is coloured in the row meta *or* the group label, not both; a count badge is `attention` only when someone must act.
6. **Settings have three audiences**: *You* (follows the person), *Family* (the household, by its managers), *System* (the server). In settings, the settings list is the navigation, not the app's sidebar.
7. **Width decides, never the device.** Container queries size components; windows choose templates. Touch targets are 44 px wherever a finger may land (every phone and the display), 40 px with a mouse.
8. **Colour carries meaning.** Semantic colours (`attention`, `now`, `sun`, `info`, `heat`) describe state only and are never assigned to people. Member colours identify people only.
9. **Big actions take two taps; undo over confirm.** Reject, delete and other hard-to-undo actions ask "tap again" and wait 4 s for the second tap. Approving, completing and ticking are one tap with an Undo.
10. **Instant, then honest.** A tap updates the screen at once; if the server does not confirm, the change is rolled back and the reason shown.
11. **AI shows its uncertainty.** Fields the model is unsure about are marked "check this".
12. **Theme follows the light.** Phones and computers follow the system's day or night setting; displays switch to night at sunset.

Borrowed: Things 3 (one list, inline composer, quiet group labels) for Lists; Apple Reminders (the row with a circle, Cancel · Title · Done) for phone forms; Linear (settings as a mode with its own sidebar and search, `⋯` menus, keyboard hints); macOS System Settings (label left, control right in 20 rem, saved as you go) for the setting row; Notion (one filled button per view, ghost section actions, properties in one line) for records; Fantastical and Apple Calendar (hour grid, now-line); Skylight and Hearth (big date, few colours, readable across a room) for the display; Todoist (natural-language composer, `Add details`); Google Keep (coloured papers) for the Board.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **wall** | The page background (`wall`). |
| **tile** | A standalone row on the wall: `surface`, `shadow-lit`, radius 12, 48 px (56 with two lines). Tasks, shopping items, list items, nav rows. |
| **quiet row** | A receded row on the wall: `idle`, no shadow, radius 12. Done items, empty-section lines, notices. |
| **card** | `surface`, 1 px `line`, no shadow, radius 16; holds `rows` divided by 1 px `line`. Settings, record sections, members. |
| **lit card** | A card with `shadow-lit` and no line. Only for the one thing that matters on the page (Needs you, the next event, the first-steps hero). |
| **row** | A line inside a card: 48 px (56 with two lines), 12 px horizontal padding, a leading disc / avatar / check, text, trailing pill / button / `⋯` / chevron. |
| **section** | A label on the wall (12/700 uppercase `ink-soft`), its count, its actions at the right, then rows or a card. |
| **composer** | The inline add field: a tile with a `+`, placeholder in `ink-soft`; Enter adds. |
| **panel** | The side panel (≥ 1024 px): 420 px, `surface`, line on the left, `shadow-pop`, title row, scrolling body, sticky footer. |
| **sheet** | The phone form container (< 1024 px): full height, `surface`, Cancel · Title · Save bar, scrolling body. A *half sheet* is for short choices (a date, a list to pick). |
| **menu** | A popover list of actions (desktop, from `⋯`); on the phone an *action sheet* from the bottom. |
| **dialog** | A centred 400 px modal for the few interrupts that must block. |
| **disc** | A 36 px `idle` circle with an 18 px icon: the "kind" of a row. 28 px small, 56 px large (record headers, empty states). |

## 3. Layout system

### 3.1 Breakpoints and shells

| Width | Shell | Notes |
|---|---|---|
| < 768 | Phone: bottom tabs (Today · up to 3 primary pages · More), one column, 16 px gutters | `--ctl: 44px`. Forms are sheets. |
| 768–1023 | Tablet rail (80 px) + one column, 24 px gutters | `--ctl: 44px` (assume touch). Forms are sheets. Content max 720 px, centred. |
| 1024–1279 | Sidebar (248 px) + content, 32 px gutters | `--ctl: 40px`. Forms are panels. Two-column templates and seven-column boards (the calendar week) allowed. |
| ≥ 1280 | Sidebar + content, 40 px gutters | All templates. Content max 1200 px, centred (the standard width class, §3.2); reading text max 62ch. |
| Display (`/display`) | Today in family mode: the display's style at the screen's own width, never scrolled | One type step larger than a person's Today from 1024 px, one more on a TV-sized screen. A busy day first shows fewer things per person, then leaves out blocks (the photo, the weather's hours, the extras, the chores), and only last zooms out, never below a person's size. `--ctl: 52px` for the few touchable things. |

Settings mode (§7) replaces the sidebar with the settings list at ≥ 1024 and is a page stack on narrower windows.

### 3.2 Page templates

Every page uses exactly one template and renders inside **`<Page template=…>`** (`@famos/ui/famos`), the only page frame. `Page` owns the page's width, centring and head (`title`, `subtitle`, `actions`); a page never writes its own maximum width, `mx-auto` or negative margins, and the shell's `<main>` keeps only the gutters. An extension picks a template, never invents a frame. `ListDetail` is the `list-detail` template (it renders a `Page`); a `Page` inside a `Page` adds no second frame.

**Width classes.** Each template sits in one of four classes (`PAGE_WIDTH` in `page-frame.ts`). Every class centres the same way, so within a class titles start at the same x and nothing sticks to the left:

| Class | Width | Templates (`template=`) |
|---|---|---|
| Narrow | 760 px, centred | `chat` (Assistant), `capture` (Quick add, Share) |
| Medium | 60 rem, centred; 76 rem from 80 rem of room when the page has `settings-pair` sections (§7) | `settings` (every settings page, More) |
| Standard | 1200 px, centred | `list` (Tasks, Shopping, Notifications), `list-detail` (Vehicles, Pets, Home, Chores, Kitchen with its Meal plan tab), `record` (a home's item or service) |
| Full | the whole content area between the gutters | `day` (Today), `calendar` (Calendar), `board` (Board: also bleeds into the gutters, edge to edge, over its `backdrop`) |

Inside its frame, widths are for things (a card, a 420 px empty state, running text at `max-w-prose`), never for the page. Two frames do more: `board` bleeds into the shell's gutters and gives them back as padding, and `chat` fills the window so its message box sits at the bottom, with the history as an `aside` pane from 1280 px (hugging the frame's left edge, full height, behind a hairline; the 760 px conversation centred beside it). The shell passes its gutters as `--shell-x`, `--shell-top` and `--shell-bottom` (preview bar included), so these are handled once. `scripts/page-frame.test.ts` fails, naming the file and saying to use `<Page template=…>`, when a page in `apps/web/src/routes` or `extensions/*/src/web` sets a page-level width (`max-w-[…]` of 40 rem or more, `max-w-4xl` and up, a CSS `max-width` of 40 rem or more), centres or bleeds its outermost element, or (an app route) renders no `Page`.

| Template | Pages | ≥ 1280 | 1024–1279 | < 1024 |
|---|---|---|---|---|
| **Day** | Today, `/display` | The style's composition. **Broadsheet** (default): three columns `280px 1fr 300px`: the atmosphere (clock, date, weather, photo, statuses, chore rings: how is everyone), the day (the accent hero, a column per person, the board, ahead), what needs doing (Needs you, shopping as a big number, the tasks, the kitchen). **Wall**: two columns `400px 1fr`: the atmosphere (clock, temperature and bars, the board, the photo) and the day (Needs you, the hero with a countdown ring, "Who, next" as a row per person with a chore ring, three tiles). **Lanes**: the head, the departure-board hero with "Then", the day chart (07:00–22:00, hourly weather on the axis, a lane per person, at most six plus "Others", one for the family, the now-line), then a band (Needs you, chore bars, shopping, ahead, the board); the sidebar stays | Broadsheet: the atmosphere as a band on top, the day and the family (300 px, with statuses and chore rings) side by side. Wall: the clock and the weather share a band, the rest in one column. Lanes: as wide | One column: Broadsheet stacks the day by person (people with something first, the rest in one line), with the family as a strip of names above it when a facet has a word about them ("Home"); Wall's rows drop the name column; Lanes turns the chart upright (at most five person columns, then "Others"). No sideways scrolling |
| **Board** | Calendar, Board | Full width; details in the panel | Same (the calendar keeps its hour grid) | Agenda / one column; details as a page |
| **Lists** | Tasks, Shopping (two pages: a "Lists" group in the sidebar, one Lists tab on the phone that opens the page used last) | Head with a count; the add field on top; Tasks puts what is near (Overdue, Today, This week) and what is later (Later, No date) side by side when both have something; Shopping puts "In the cart" in a column beside the list | Same | One column; the title is a switch in type ("Tasks  Shopping"); Shopping's add field sits above the tab bar |
| **List + detail** | Vehicles, Pets, Home, Recipes (and the Meal plan tab), Chores | 280 px list column + detail (the rest of the 1200 px frame) | 260 px + detail | List page → item page |
| **Record** | A vehicle, a pet, a home, a recipe (the detail of the above) | Record header, sections | Same | Same, stacked |
| **Overview** | AI usage | A facts card, then sections | Same | Stacked |
| **Table-ish list** | AI activity, app keys | Rows with group labels (never an HTML table) | Same | Same, fewer columns |
| **Chat** | Assistant | 760 px centred column; the history a pane at the left edge, the column centred beside it | Same | Full width; history as a sheet |
| **Settings** | Every settings page | Settings list + content column up to 60 rem, centred (§7) | Same | Page stack |
| **Capture** | Quick add | 760 px centred column | Same | Same |
| **Empty** | Any page with nothing | One empty state in the content area (§3.6) | Same | Same |

**Where Today's parts come from**: the Day template names no extension. The day comes from timeline contributions; the cards from `dashboard.card`; the chore rings and bars, the word beside a person's name ("Home"), the photo, the weather's hours and the first steps from Today **facets** an extension provides (`perMember`, `memberStatus`, `photo`, `weather`, `setupHint`); the meals' list from the block that claims the day's meals. A style draws a facet in its own shape and leaves its place out when no enabled extension provides it or the viewer may not read it, so a missing extension never leaves a gap or an empty heading.

**What Today shows**: each block of the Day template (the app's own, those extensions add such as chores and meals, and every `dashboard.card` by its id; `apps/web/src/lib/today/blocks.ts`) can be hidden by a person, the family's default or a display: in Settings (Appearance; Family → Family look) and from the `⋯` at the end of a block's label (`TodayBlock` + `TodaySection`/`TodayBlockMenu`; a menu on wide windows, an action sheet on phones; a toast with Undo). Show or hide only: the style keeps its composition, and a column left empty gives its room to the others. Everything hidden is an `EmptyState` with one action back to the list.

### 3.3 Grid, spacing, density

- Spacing scale: 4 · 8 · 12 · 16 · 24 · 32 · 48. Vertical rhythm: 6 px between tiles, 12 px between a section label and its content, 28 px between sections, 24 px after the page head.
- Columns are `minmax(0, 1fr)` grids; lists of tiles use `repeat(auto-fill, minmax(min(22rem, 100%), 1fr))` only when the items are independent (chores, homes), never for ordered lists (tasks).
- Density is fixed by the system, not a user option: rows 48/56, controls 40/44, meta 13 px. The family display has its own type step (§3.1).
- Text width: body text and hints ≤ 62ch; page subtitles ≤ 2 lines (move the rest into a hint or a `?`).
- Inside components, container queries, not window queries: forms pair fields from 40 rem of container; setting rows go side by side from 32 rem; the record header puts the actions under the name below 28 rem.

### 3.4 Surfaces and elevation

| Level | Surface | Use |
|---|---|---|
| −1 | `idle`, no shadow | Quiet rows, done items, notices, kind discs, filter chips (off), segmented control track |
| 0 | `surface` + 1 px `line` | Cards, fields on the wall, panels' inner cards |
| +1 | `surface` + `shadow-lit` | Tiles, the active nav row, the selected item, the one lit card per page, a focused composer |
| +2 | `surface` + `shadow-pop` (= `shadow-lit` + `0 12px 32px rgb(0 0 0 / 0.14)`) | Panels, menus, popovers, dialogs, the toast |
| sheet | `surface` + `0 −8px 40px rgb(0 0 0 / 0.18)` over a 35 % scrim | Phone sheets |

Never +1 inside +1. A card (0) may hold rows but not tiles. The wall may hold tiles and cards side by side.

### 3.5 Page head

- Desktop: `h1` 24/800 left; on a list page a count in `ink-soft` 17/600 after it (`Members 3`); the primary action (one filled button) right, with at most one secondary (outline or ghost) beside it. No subtitle by default; a page that needs explaining gets one 15 px `ink-soft` line (≤ 2 lines). A longer explanation belongs in the empty state.
- Phone: `h1` 24/800; a Back icon button at the left when the page is not a tab; at the right at most one icon button (filter, bell on Today) and the `+` (§4.3).
- On a record page the record head (§5.8) replaces the page head.

### 3.6 Empty states

One shape for a page with nothing yet (`EmptyState`): a centred card (0) of max 420 px, the area's drawing (`art`), a 17/700 line saying what the page is for or what is missing (`No vehicles yet`), one 14 px `ink-soft` line on what to do and why (`Add one to keep its insurance, inspection and service dates in one place.`), and the primary action. Warm and plain: what the page is for, then the one thing to do.

**The drawings** (`art`): one small line drawing per area, `calendar`, `tasks`, `shopping`, `board`, `chores`, `vehicles`, `home`, `pets`, `kitchen`, `assistant`, `quick-add`, `devices`, and `generic` for a page without its own (`EMPTY_ART_NAMES` in `@famos/ui/famos`). `EmptyArt` draws them all in one hand: inline SVG of 120 × 88, rounded 1.75 px strokes in `currentColor` (`ink`), a soft `idle` ground, shapes in `surface`, one accent in a soft `sun`; tokens only, so every pack and night draw them right, about 2 KB each. A new area adds its drawing to `EmptyArt` and its name to the list; a page with no fitting drawing uses `generic`, never an icon of its own. `icon` (a 52 px disc) remains for the rare empty state that is not a whole page's.

**A section with nothing** (in a record or a settings page) is not an empty state but one quiet line, `EmptyLine`: a 48 px `idle` row with the section's 18 px icon, the sentence (`No papers yet.`) and an optional quiet link or text button at the end. Today uses its own `QuietLine`.

One empty state per view: an empty page shows its `EmptyState` alone, never a second one for a column or panel beside it. A column with nothing shows the empty state inside the column, not beside it; list + detail with zero items shows the empty state alone (no list frame); with one item, the item is the page (no list column) until there are two.

### 3.7 Loading

A page opens once, whole. It never shows its head first and its body a moment later, and an empty state never stands in for data that has not arrived.

- **The shell** shows nothing for the first 800 ms while the app and the session load (the empty wall, no "Loading…" page), then the same quiet mark. Before the app has started, `app.html` draws that mark in plain CSS (same size, same delay) and the app removes it when it takes over; the same mark shows while a page's code is still downloading on a slow network (a navigation in flight, an extension page's module).
- **A page** is mounted at once, so it starts loading, but stays transparent (`opacity: 0`, no pointer events, so layout and focus stay sane) until its first data is in; then the whole page fades in over 120 ms (no fade under `prefers-reduced-motion`). "First data" is every read started while the page opened, plus the family settings and the shell's language, including any capability, list name or setup state that arrives with them.
- **Slow loads.** After 800 ms a quiet centred indicator fades in; a fast load never shows it. After 6 s the page shows as it is.
- **Later changes stay in place.** Live events and actions update the page where it stands and never hide it again.

This is built in: `PageGate` (`apps/web/src/lib`) wraps every route and every extension page and waits on the reads in flight (counted at `fetch`, `net-activity.svelte.ts`). A page loads its data the usual way and renders an empty state only from the load that proves emptiness (`loaded && items.length === 0`), never before.

### 3.8 A page that is not for you

A page says who may open it with `requires` (a capability), the same as its navigation entry: the menu hides the way to it, and `requires` keeps it closed to a typed address, a bookmark or a shared link. The shell checks it once for every page, the app's and the extensions', and shows **`NoAccess`** instead, without loading the page: the page's frame with its menu name as the head, an `EmptyState` (`generic` art) with `This page is for people who may use Members`, one line on who can give access, and **Back to Today**. Never a redirect, a toast or a page of refused reads. A page never checks this itself: give it `requires` (an extension's `PageContribution`, the app's settings entry); a record page under a list asks for what the list asks for (`scripts/page-access.test.ts`).

## 4. Creating and editing

### 4.1 Which container

| Situation | Desktop (≥ 1024) | Phone and tablet (< 1024) |
|---|---|---|
| One line of text is enough (a task title, shopping items, a note) | **Composer** inline; `Add details` opens the panel | Composer inline; `Add details` opens the sheet |
| A form of 2–12 fields (event, task details, vehicle, pet, member, chore, treatment, service entry, obligation, app key, backup copy, sender) | **Side panel** | **Sheet** (full height) |
| A short pick (date, list, role, a preset's schedule) | Native control or a **menu** | **Half sheet** |
| Reading an item before editing (an event, a draft, a capture) | Panel in *view* mode with an `Edit` button that swaps to the form | Page or sheet in view mode, `Edit` in its bar |
| Something that must block (sign out everywhere, restore a backup, delete a role in use, remove a member) | **Dialog** | Dialog (centred, 90 % width) |
| A flow with more than one thing to do, done once (adding a device, locking the backup copies, connecting an AI app) | **Side panel** with guided steps (§4.7) | **Sheet** with guided steps |
| A long multi-step setup (mailbox, first run) | Full page in the settings column | Full page |
| Secondary actions on a row (edit, archive, delete, file into, undo) | **`⋯` menu** | **Action sheet** |

Rules:
- No permanently open form on a page (adding a member, a sender or a language, choosing the backup encryption): forms open in panels or sheets.
- Inline editing only for a single field in place (renaming a list, changing a quantity), styled like the composer.
- A panel or sheet opened from a row shows that row's data; opened from the primary action it is a fresh form.
- Opening a panel never navigates; the URL gains `?edit=<id>` or `?new=1` so reload and Back work (Back closes it).

### 4.2 The primary action

- One filled `ink` button per view: the page's primary action in the page head. The panel's `Save` is the only other one, and the panel covers the page's.
- `attention`-filled buttons exist only inside Needs you rows and draft cards (`Add to calendar`), where the thing needing someone is resolved. Quick add's `Add selected (2)` is `primary` (`ink`), as the one filled button; `attention` stays for state.
- Section actions are ghost buttons (`+ Add a paper`) at the right of the section label. Row actions are the `⋯` menu, or one secondary button when there is one obvious verb (`Done` on an obligation).

### 4.3 Where "add" lives on the phone

- A list page (Vehicles, Pets, Homes, Chores, Recipes): a 56 px floating `+` above the tab bar, right, `ink` with `shadow-pop`, hidden while a sheet is open or the keyboard is up. Tablets (768–1023) have no floating `+`; the head's `+` is enough.
- A page with a composer (Lists, Board, Memory): no FAB; the composer is the add.
- A settings list page (Members, Devices, App keys, Copies): a 44 px filled `+` icon button in the page head.
- A record page: `Edit` (outline, small) and `⋯` in the head; sections keep their ghost actions.

### 4.4 Panel and sheet anatomy

Panel (desktop): 420 px (360 at 1024–1279), full window height, fixed right, `surface`, 1 px `line` left, `shadow-pop`. Header 56 px: title 17/800, close `×` (36 px ghost icon button). Body scrolls, 20 px padding. Sticky footer: `Save` (ink) · `Cancel` (ghost) · a destructive two-tap button at the far right when editing. Focus moves to the first field; Esc closes (asks when dirty); `⌘/Ctrl+Enter` saves.

Sheet (phone/tablet): full height from 12 px below the top, radius 14 at the top, a grab handle, a 52 px bar with `Cancel` (ghost) left, title 16/800 centre, `Save` (ink, small) right; the body scrolls with 16 px padding and 24 px bottom padding plus the keyboard inset. A half sheet (≤ 85 %) is for pickers and action sheets. Swipe down or Cancel closes (asks when dirty). The browser's Back button closes the open sheet the same way and stays on the page (a sheet holds one history entry while open, `sheet-history.ts`).

Forms: fields 18 px apart; related short fields pair at ≥ 40 rem of container (and in the sheet for date + time, plate + fuel); `optional` in the label in `ink-soft`; hints 13 px under the field; errors 13/600 `attention` under the field with an `attention` border (`FieldError`, linked with `fieldAria`; a validator returns a reason key per field, `FieldErrors`, and a refused Save focuses the first with `focusFirstInvalid`). Save stays enabled: an empty required field is refused with its reason, never by a greyed-out button. Placeholders are examples (`e.g. Hallway`) so they never read as a value. Member pickers are chips; ≤ 4 options are a segmented control; presets with a per-item schedule are a checklist card (the vehicle form).

### 4.5 Opening and editing rows

- Tapping a row opens it (the item page on list + detail pages, the panel/sheet elsewhere), except where the row's main tap is a verb (a task's check): the text opens, the check completes.
- No pencil icons or text links for secondary actions on rows; `⋯` holds them. No hover-only controls (touch).
- Selection in a list column: a 2 px `ink` inset ring on the tile; `aria-current="page"`.

### 4.6 Confirm, undo, keyboard

- Deleting, archiving, removing, clearing, dismissing: two-tap (`ConfirmButton`, 4 s) on a page or in a panel footer; a dialog when the action is in a menu or has consequences beyond the item (a role in use, sign out everywhere, restore).
- Completing, approving, adding from a composer, ticking a shopping item: one tap plus a toast with `Undo` (10 s).
- Saving a form: one tap; the panel closes; a toast only when the result is not visible (`Sent for approval`).
- Keyboard (desktop): `n` Quick add, `/` search (on pages that have one), `g t` Today and `g` plus a navigation entry's `shortcut` key (`g c` Calendar), `Esc` closes, `⌘/Ctrl+Enter` saves a form, `Enter` on a focused row opens it, arrow keys move within segmented controls and menus. Single-key shortcuts are ignored while typing. Keycaps show on hover in the sidebar and in menus.

### 4.7 Guided steps

One pattern for every flow with more than one thing to do: `Steps` with numbered `Step`s in a side panel (a sheet on phones). The current step is open; the others fold to one line; a done step gets a tick and one line of what was chosen (`summary`, "Code ABCD-EFGH"); a step to come shows only its number and title. At most one filled button, in the open step. With `onselect`, a done step can be reopened until the flow is finished (to fix a mistyped code). `large` is for a screen on the wall: the display's pairing screen shows the same four steps from its side.

Use it when a person must do things in order, possibly on another device, and would otherwise read a long intro above a form: adding a device (*What are you adding?*, then the steps for a screen or a shared tablet or phone), **Lock the copies** in Backups (why, a passphrase with the "written down" tick, what to keep where), **Connect an AI app** in Connected apps (turn on, create a key, copy the settings). Not for an ordinary form (one panel, one Save) or a single confirmation. The texts say what happens, not how it works; a word the family needs later (a "passphrase") is explained once, in the step that first uses it. A first choice that decides the following steps (a screen or a shared device) comes before the steps, as rows that open them.

### 4.8 What you may do

The page offers what the viewer may do and says so when it does not. That is the server's decision per action (`GET /core/access`, and `POST /actions/{id}/check` where the input decides), read through `app.access(actionId)` and `app.accessFor(actionId, input)` (`@famos/ui/app`); a page never works it out from a capability or a role. The answer is `apply`, `suggest`, `no` or `depends` (the input decides, such as whose thing it is: offer the control, and ask `accessFor` once a form holds the input). It is read with the session, again when a role, a member or an extension changes, and after a refused change, so the next draw is right.

- **`no`: the control is not drawn.** No disabled buttons and no look-alikes: a check that cannot be ticked is a plain status mark (a filled disc when done, a small dot when open), not a circle button. A row whose tap would open an editor the viewer may not use opens nothing, or details only (an event).
- **`suggest`: the form says so before anything is typed.** `SidePanel` takes `approval={app.approval(actionId, input?)}`: one line under the title (in the sheet it stays under the bar while the form scrolls), and the save button reads **Send for approval**. Where the input decides (a task of one's own is saved at once), pass the input, so the form never says "someone has to approve" when it will not.
- **`apply`: as usual.**
- **`suggest` reads first.** A row that opens a form opens, for this viewer, the thing's details (`DetailRows`) with one button, **Suggest a change**, and the form only on it: `SidePanel` takes `readFirst={readFirst(app, actionId, details, { key })}` (undefined for anyone else, so nothing changes for them). A record page's Edit button says the same (`editLabel`).
- **What waits is shown where it is.** A thing a waiting change is about carries `AwaitingMark` (an hourglass and text that wraps rather than being cut; for the person who asked, and with who asked for those who may decide; `app.awaitedChange(id)`). A new entry that waits is a quiet `AwaitingRow` in its list (`app.awaitedNew(actions, aboutId)`): an hourglass in a dashed disc where a saved row has its icon, the title in `ink-soft`, no hover, nothing to open, and the facts a saved row shows after "Waiting for approval" (`detail`), so it never reads as saved and a list never reads as empty while one waits. On the calendar a waiting new event is a ghost chip (dashed outline, `ink-soft`, an hourglass, label "Waiting for approval: <title>") from the same `app.awaitedNew`; tapping it opens its details read-only. A waiting removal says so ("Waiting for approval to remove"): the presenter of a delete, remove or archive action sets `removes` (`removalPresenter` when it has nothing else to show).
- **An empty state invites only those who may add**: without the add action, the title alone, no hint.
- **A page whose main action is `no` says "View only"**: a quiet `ViewOnly` pill in the page head in place of the primary button, once per page. A tap opens one line under it: "Your role lets you see this. {who} can change what your role may do.", naming the members whose role may change roles (`app.roleManagers()`); announced, works on touch, never a hover tooltip. A page with two main acts (Chores, Shopping, Tasks: add and tick) says it only when neither is open to the viewer.
- **A display shows, never offers.** Its answers are all `no`: nothing on it is actionable.

## 5. Components

All of them live in `@famos/ui/famos` (vendored shadcn-svelte primitives in `@famos/ui/components`), except Today's compositions and the Lanes parts, which are the app's (`apps/web/src/lib/today/`); extensions use them too, never a look of their own.

| Component | Notes |
|---|---|
| `Button` (shadcn) | Variants in §5.1; heights from `--ctl`. |
| `Input`, `Label` | Height `--ctl`, radius 10, `surface` on wall / `wall` in cards. |
| `Combobox` | Time zone, region, tags, categories. |
| `MemberChips` | The ring is the member colour. |
| `RepeatPicker`, `ScheduleFields` | Presets as a segmented control (`Never · Daily · Weekly · More…`); custom in a half sheet / inline below. |
| `PageHeader` | §3.5; count prop; subtitle discouraged. |
| `PageTabs` | Underline tabs for page sections only. |
| `Tile` | The tile of §5.6 (48/56 px, title 600). |
| `SettingRow`, `SwitchRow` | Inside `Card`; control column 20 rem; `inline` variant on phones for switches. |
| `SidePanel` | Footer slot, dirty check, URL sync, 360 px at 1024–1279; renders the sheet below 1024. |
| `Page` | The one page frame: template, width class, centring, page head (§3.2). |
| `ListDetail` | 280 px list column; single-item rule (§3.6); the `list-detail` frame. |
| `ConfirmButton` | Two-tap confirmation with the `danger` look (`destructive` text, filled when armed). |
| `Toast` | 44 px, `Undo` as a bold button. |
| `DraftCard` | A suggestion: kind, title, fields, where it came from, uncertain fields marked; Reject (two-tap) · Edit · Add; applied state with Undo. Shared by every extension. |
| `HelpTip` | The one help mechanism besides hints. |
| `Avatar`, `DisplayPill`, `DisplayRow`, `DisplaySection` | The display's pills in the head and the `display.widget` band at the foot of the composition. |
| `TodaySection`, `TodayRow`, `QuietLine`, `TodayBlock`, `TodayBlockMenu` | Today's sections; `TodayRow` and the tile share one style (§5.6). |
| `Timeline` | The calendar's. |
| `Clock`, `DateLine`, `WeatherBlock` (`HourlyStrip`, the sentence), `NextUpHero` (`Countdown`, the Family / Me toggle), `MemberDay`, `FamilyList`, `Ring`, `ChoreRings`, `BigNumber`, `PhotoTile` | Today's parts, shared by the three compositions (`apps/web/src/lib/today/`); pure rules in `today-v3.ts`. Lanes adds `DayChart`, `DayChartVertical`, `DepartureBoard`, `ChoreBars`, `WeatherRow` (`apps/web/src/lib/today/lanes/`, layout in `chart.ts`). |
| `Card`, `Row` | §5.6. |
| `Section` | §5.5 label row with count and actions. |
| `Composer` | §5.9. |
| `Segmented` | §5.3. |
| `Chip` | filter / member / preset variants (§5.3). |
| `Pill` | Status pill (§5.7). |
| `Menu` / `ActionSheet` | §5.11. |
| `Sheet` | The phone form container (§4.4); `SidePanel` delegates to it. |
| `Dialog` | §5.11 (plain Svelte, `<dialog>`). |
| `EmptyState`, `EmptyArt`, `EmptyLine` | §3.6; `art` names the area's drawing. |
| `Steps`, `Step` | Guided steps, §4.7. |
| `WeatherSky` | The weather as a sky behind `WeatherBlock` and ambient mode, §6.5. |
| `RecordHeader`, `Facts` | §5.8. |
| `IconButton` | 36 / 40 / 44 px ghost or outline. |
| `Fab` | §4.3. |
| `Notice` | §5.10. |
| `ViewOnly` | The "View only" pill in a page head; a tap says why and whom to ask, §4.8. |
| `AwaitingMark` · `AwaitingRow` | What waits for approval: the mark beside a thing, the quiet row of a new entry, §4.8. |
| `DetailRows` | A thing's details, read only, label above value (the `readFirst` view of a `SidePanel`), §4.8. |

### 5.1 Buttons

| Variant | Look | Use |
|---|---|---|
| `primary` | `ink` fill, `surface` text | The one page action; `Save` in a panel |
| `secondary` | `idle` fill, `ink` text | Row verbs (`Done`), chip-like toggles, secondary form buttons |
| `outline` | transparent, 1 px `line`, `ink` text | `Edit` in a record head, actions on cards |
| `ghost` | transparent, `ink-soft` text, `idle` on hover | Section actions, `Cancel`, icon buttons |
| `go` | `attention` fill, `on-color` text | Only inside Needs you rows and draft cards |
| `danger` | transparent, `destructive` text; armed: `destructive` fill, `on-color` | Delete / remove / archive (two-tap) |
| `link` | `info`, underlined | Inline in text and quiet rows |

Sizes: `sm` 36 px / 14 px text; default `--ctl` (40 / 44); `lg` 44; `kiosk` 52 (the family display). Icon buttons are square at the same heights. Radius 10 (`--r-ctl`), pill radius for FAB and chips. States: hover 150 ms colour, active none (no translate), focus `0 0 0 2px wall, 0 0 0 4px info`, disabled 45 % opacity, loading swaps the icon for a spinner and keeps the width. Text 15/600, never uppercase.

### 5.2 Fields

Height `--ctl`; radius 10; 1 px `line` inset; `surface` on the wall, `wall` inside a card/panel/sheet so the field reads as a well; text 15; placeholder `ink-soft` at 80 %. Focus: 1 px `info` border + 3 px `info` 25 % ring. Invalid: 1.5 px `attention` border + 13/600 message. Disabled: 50 %. Textarea: min 84 px, same chrome. Select: native `<select>` with the same chrome and a chevron icon (not the OS arrow); `Combobox` from 8 options. Date/time: native inputs with a leading icon. Units (`EUR / month`) sit inside the field in `ink-soft` 14/600. Labels 14/600 above, `optional` in `ink-soft` 400 after the label.

### 5.3 Choices

- **Segmented control**: `idle` track with 3 px padding, pill radius, height `--ctl` (36 for `sm`), options 14/600 `ink-soft`, the chosen one `surface` + `shadow-lit` + `ink`. ≤ 4 options, all visible, equal padding; `grow` makes options share the width (phone). Arrow keys move; `role="radiogroup"`.
- **Chips** (36 px, 40 on touch, pill): *filter* `idle`/`ink-soft`, on = `surface` + 2 px `ink` inset ring; *member* has the avatar and the member colour as the ring; *preset* is outlined with a `+` and adds something when tapped (a button, not a toggle).
- **Check** (26 px circle, 2 px `ink-soft` 55 % ring; done = `now` fill with `on-color` check; a member-coloured ring when assigned): tasks, shopping, chores. **Checkbox** (20 px, radius 6, `ink` fill when on): forms and multi-select. **Switch** (44 × 26, `now` when on): settings. **Radio** only where a native radio is semantically right (rare).

### 5.4 Nav rows, tabs, phone tabs

Sidebar rows 36 px, active = `surface` + `shadow-lit`; the bell and `+` in the head; the Household disclosure (§7.1). Phone tabs in §7.1. Settings mode in §7.3.

### 5.5 Section label

`t-label` 12/700 uppercase `ink-soft` with 0.06 em tracking; count after it in 12/600 (not uppercase, not a badge); actions at the right as ghost buttons 32 px / 13 px with a 15 px icon. 24 px min height; 10 px to the content. Group labels inside a column (`OVERDUE`, `TODAY`, `FRUIT & VEGETABLES`) use the same style with 10 px top padding, no actions and no colour. On Today the label takes the style's caps (`--ramp-label`, Broadsheet 11/700 at 0.12 em).

**Big number**: a glanceable total is a number readable from the door, not a count in a label: the value in the display face at `--ramp-big` (Broadsheet 64 px), a 15/700 title beside it ("items to get") and a 13 px `ink-soft` detail under the title. Only for totals someone acts on at a glance (shopping, the countdown, the temperature); never a badge, never a state colour. A card offers it through `form: 'glance'` of `dashboard.card`.

### 5.6 Rows, tiles, cards

- **Row**: `display:flex; gap:12px; min-height:48px; padding:6px 12px`. Leading: disc / avatar / check / 18 px icon in `ink-soft`. Text: title 15/600 `ink`, meta 13/400 `ink-soft`, each one line with an ellipsis (two-line rows are 56 px). Trailing: pill, amount (15/700), secondary button `sm`, `⋯`, chevron (`ink-soft`), avatar. Hover (mouse only): `idle` at 55 %. Done: title 500 line-through `ink-soft`.
- **Tile**: a row on the wall (§2), 6 px apart. Idle tile: `idle`, no shadow. Selected: `shadow-lit` + 2 px `ink` inset ring.
- **Card**: as in §2; padding 16 × 20 when it holds text instead of rows. `lit` variant: shadow, no line. `quiet` variant: `idle`.
- `TodayRow` takes the tile style (title 600, 48 px); Needs you rows stay rows inside the lit card.

### 5.7 Badges, pills, state text

- **Badge**: 20 px min, `attention` fill, `on-color` 12/800, only for counts that need someone (Quick add, bell). Never for totals.
- **Pill**: 24 px, 12/700, `idle` fill and `ink` text by default. Tinted variants put a 15 % tint of the state colour behind text that is the state colour **mixed toward `ink`** (`attention`, `now`, `info`: 65 % state + 35 % ink; `heat`, `sun`: 50/50), never the pure state colour, which falls to 3.7–4.4:1 on its own tint in most packs. `solid` is `now`/`on-color` for done. Tints are `color-mix` in code, not tokens.
- **State text** (on `wall`/`surface`/`idle` only): 13/700 in `attention` (overdue), `now` (now, done), and `heat` mixed 50 % toward `ink` (due soon). One per row.

### 5.8 Record header and facts

A 56 px disc (or the photo, rounded), the name in `type-record`, a meta line of facts separated by `·` in 14 px `ink-soft` with the members' avatars at the end, and at the right `Edit` (outline) + `⋯` (outline icon). Below 28 rem of container the actions move under the name. Totals use **Facts**: a card with 2–4 facts, each a 12/600 uppercase label and a value in `type-figure` (the display face).

### 5.9 Composer and search

Composer: a 48 px tile with a `+` (18 px `ink-soft`), a 15 `ink-soft` placeholder that teaches the syntax (`Add items… milk, 2 kg tomatoes`), a `↵` keycap at the right on desktop. Focus: `ink` text, 1.5 px `info` inset. With text, the task composer shows `Add details ›` (13/700 `info`), which opens the panel/sheet pre-filled. Enter adds and keeps focus; Esc clears. Search: an `idle` field 36 px (44 on touch) with the search icon and `/` keycap.

### 5.10 Empty state, notice, quiet row

§3.6 for the empty state. **Notice**: a quiet row with a leading 18 px icon (`info` default, `heat` for warn, `attention` for alert) and 14 px text, for previews, server-set values and warnings inside the form that needs them. A default-state warning is a notice, never an attention-coloured sentence.

### 5.11 Menu, action sheet, dialog, toast

Menu: `surface`, radius 16, `shadow-pop` + 1 px `line`, 6 px padding, items 40 px 14/600 with 16 px icons, a separator before destructive items (`destructive` text), keycaps at the right. Action sheet (phone): from the bottom, radius 18 top, items 48 px 16/600, a title block with the item's name, a `Cancel` row in `idle` with 6 px gap. Dialog: 400 px (90 % on phones), radius 16, title 18/800, body 14 `ink-soft`, actions right (ghost + the consequence button; destructive ones start armed). Toast: 44 px pill, `ink` with `wall` text 14/600, `Undo` 800, above the tab bar on phones, bottom-centre on desktop, one at a time; 10 s with an action such as Undo, 5 s without, held while the pointer or focus is on it.

## 6. Typography, icons, motion

### 6.1 Scale

| Style | Size/weight | Use |
|---|---|---|
| record | `type-record`, 800, −0.015 em | A record's name: Broadsheet 30, Lanes 26, Wall 34 (26 before a style is set) |
| page | `type-page`, 800, −0.015 em | Page titles: Broadsheet 28, Lanes 24, Wall 32; on phones 26 · 24 · 28 (24 before a style is set) |
| section | 17/700 | Column titles (`Tasks`), dialog titles 18 |
| row | 15/600 | Row and tile titles, buttons, nav |
| body | 15/400, 1.45 | Running text, hints in panels |
| meta | 13/400 `ink-soft` | Row meta, hints under fields, state text at 700 |
| label | 12/700 uppercase, 0.06 em, `ink-soft` | Section and group labels, facts labels |
| tiny | 11/600 | Phone tab labels, keycaps, badges in the rail |

Three voices, each a font slot a theme pack may fill from the bundled families: **body** (`font`, Figtree) for everything above; **display** (`font-display`, Broadsheet: Barlow Condensed 600) for the clock, the countdown, big numbers, times on day cards and the day labels of Next days, never running text; **serif** (`font-serif`, Broadsheet: Instrument Serif 400, italic for the date and sentences) for the date, the hero title, the weather sentence and quiet notes at 18 px and up, never body text or buttons. Their sizes are the style's type ramp (code, not tokens):

| Role | Broadsheet at 1440 (1024 · phone) | Lanes at 1440 | Wall at 1440 | Use |
|---|---|---|---|---|
| clock | 124 (88 · 56) display | 92 display | 150 | Today's clock |
| countdown | 128 (104 · 84) display | 84 display | 96 | The hero's minutes; a duration at half, the start time at three quarters (Wall: the ring's size, its minutes at 0.54, so 52) |
| big | 64 (52 · 56) display | 56 display | 96 | Temperature, big numbers |
| hero | 54 (44 · 38) serif | 36 | 44 | The next-up title |
| date | 34 (28 · 24) serif italic | 26 | 24 | The date under the clock |
| sentence | 20 (18 · 18) serif italic | 16 | 18 | The weather sentence; quiet notes at 1.2× |
| caps | 11/700, 0.12 em | 11.5/700, 0.16 em | 11/700, 0.14 em | Section labels on Today, the weekday, hero labels |

Fonts per style: Broadsheet, Barlow Condensed (display) and Instrument Serif (serif); Lanes, Archivo at 80 % width (display) and no serif (the body face); Wall, Figtree in every slot. A theme pack's `font-display` and `font-serif` replace the style's choice; the sizes never change. The ramps live in `packages/ui/src/styles.css` under `[data-style]`, with smaller values for the 1024 band and the phone.

Weights 400 · 600 · 700 · 800. Digits tabular everywhere. Bold inside a sentence is 700; titles never go above 800. Pages other than Today take the ramp only through the role classes of `@famos/ui/type.css`: `type-page` (page titles) and `type-record` (a record's name) in the body face, sized as in the table above; `type-day` (the day number of a day head) and `type-figure` (totals, Facts) in the display face; `type-dateline` for a date line (the calendar's range and the agenda's day: Broadsheet's serif italic, bold body elsewhere). The calendar's hour labels use the display face; its board title is capped at 28 so the toolbar stays one row. `accent` marks only today's next event (a 2 px outline on the hour grid and on the agenda's lit card).

### 6.2 Long strings and i18n

- Every row title truncates to one line with an ellipsis and exposes the full text as its accessible name; meta truncates independently.
- Buttons never truncate: a long translation widens the button, and the layout must allow a 1.6× label (test with `pnpm lang:check` strings). A four-option segmented control must fit 4 × 1.6× the English width or drop to a select at that width (container query).
- Uppercase section labels must survive language-specific case rules (Turkish dotted and dotless i): `text-transform: uppercase` with the right `lang` on the root is correct in Chromium and WebKit; test it.
- Plural keys for every count (`{{count}} open`, `Done · {{count}}`). No text in images; icons are decorative (`aria-hidden`) with a text label beside or an `aria-label`.
- Numbers, dates and money through the family's format locale, never the UI language, in `tabular-nums`.

### 6.3 Icons

Lucide, stroke 1.75. Sizes: 18 px in rows, nav and ghost buttons; 20 px in page heads and icon buttons; 24 px in the FAB, empty states and large discs; 14–16 px in chips, pills and keycaps. Icons carry no state colour except the quiet-row check (`now`), the notice icon (`info` / `heat` / `attention`) and the weather (`sun`).

### 6.4 Motion

150 ms ease-out for hover and state colours; panels slide 200 ms from the right, sheets 240 ms from the bottom, menus fade+scale 120 ms; the toast slides 160 ms; leaving (ticked) list items collapse 200 ms. Under `prefers-reduced-motion` all of it goes (opacity only, 0 ms). No bounce, no parallax; the Board's 0.4° note tilt is static.

### 6.5 The weather sky

When the weather is on, the sky behind it shows it (`WeatherSky` in `@famos/ui/famos`): clear, partly cloudy, cloudy, fog, drizzle, rain, snow or a storm, each by day and by night (the sun with a soft halo, or the moon and stars). The condition comes from the forecast's WMO code and whether it is day (`skyCondition` in `sky.ts`; unknown codes are cloudy).

- **Atmosphere, not data.** The temperature and the sentence carry the information; the sky never replaces them. On Today it fills the weather block only (every style); in a display's ambient mode without photos it fills the screen behind the clock (`size="screen"`). Text over it uses the sky's soft ink (`skySoftInk`), contrast-tested in every pack, day and night.
- **Only tokens.** Each sky is a vertical wash mixed from theme tokens (`info`, `ink-soft`, `sun`, `backdrop`, `surface`, `wall`) plus its own `sky-cloud` (clouds and fog banks) and `sky-flake` (snow), with defaults in every pack ([Appearance](../guide/appearance.md)). In light themes the night sky is a deep blue-grey, not dark.
- **Light enough for a Raspberry Pi.** HTML and CSS only; motion is CSS keyframes on `transform` and `opacity` only (drifting clouds, rain and snow as repeating gradients in three layers, a lightning flash every few seconds, twinkling stars), on at most eleven animated elements.
- **Still when asked.** Under `prefers-reduced-motion`, or with `still`, it shows the same picture without motion. It is the app's one continuous animation and never moves anything a person reads.

## 7. Navigation and settings

### 7.1 App navigation

| Width | Navigation |
|---|---|
| Phone (< 768 px) | Bottom tabs: **Today**, up to 3 primary pages, **More** |
| Tablet (768–1023 px) | 80 px rail: mark · **+** · **bell** · Today · every primary page · More as icon tiles · the person |
| Desktop (≥ 1024 px) | 248 px sidebar: head row (mark, **bell**, **+**), primary pages, a **Household** disclosure, More, the person. It never scrolls as a whole; Household closes itself first |
| Display | No navigation; view only |

- Extensions contribute pages with `placement: 'primary' | 'more'` and an optional `group` (`packages/ui/src/slots.ts`). The phone shows at most three primary pages between Today and More; the rest overflow into More, so new pages never break the layout.
- The **bell** shows the unread count and opens a notifications popover (sidebar and rail); on phones a bell in Today's head opens `/notifications`. Preferences live at `/settings/notifications`. **+** is Quick add's capture panel (`nav.action`), an icon button, never a filled one.
- An `attention` badge marks a section that needs someone (suggestions waiting on Quick add).
- The person menu: *Profile & sign-in · Appearance · Notifications · Sign out*. On the phone, More holds the rest (§7.4).

### 7.2 Settings information architecture

Three audiences, four groups (AI is a family concern but large enough to stand alone):

| Group | Pages (route) | What they hold |
|---|---|---|
| **You** | Profile & sign-in (`/settings/profile`) · Appearance (`/settings/appearance`) · Notifications (`/settings/notifications`) · Assistant memory (`/settings/memory`) · Connected apps (`/settings/connected-apps`) · Calendar on my phone (`/settings/calendar-feed`) | Name, colour, email and password, the PIN if the role has one, the person's own language, sign out and sign out everywhere; the person's own style, palette and Today; notification preferences (the list itself is the bell and `/notifications`); what the assistant remembers; app keys for their own AI agent; personal calendar feed addresses. |
| **Family** | Members (`/settings/members`) · Roles (`/settings/roles`) · Devices & displays (`/settings/devices`) · Photos & weather (`/settings/photos-weather`) · Extensions (`/settings/extensions`) · Language & region (`/settings/region`) · Theme (`/settings/theme`) · Calendars & tags (`/settings/calendars`) | Members with a roles summary; roles (on phones, one role at a time with switches); trusted devices and displays with what each display shows; display photos and the weather place; extensions installed, uninstalled, on and off; the family language, language packs and region formats; the family's style and palette, per-display looks and theme packs; calendar subscriptions and tags. |
| **AI** | Provider & models (`/settings/ai`) · What the AI may read (`/settings/ai/privacy`) · Usage & limits (`/settings/ai/usage`) · Auto-approval (`/settings/auto-approval`) | AI activity is a link from Usage. |
| **System** | Backups (`/settings/backups`) · Setup status (`/settings/setup-status`) · Email (`/settings/email`) · Telegram (`/settings/telegram`) | Server-side integrations; what is set up and what is missing, one row per check (its button goes to the page that fixes it; extensions add rows with their `setupHint` facets). |

A group shows only the pages the person may open (`requires`); a person with no Family, AI or System page sees only You. Extensions contribute settings pages with `group: 'settings', section: 'you' | 'family' | 'ai' | 'system'`. The settings column is up to 60 rem and centred, so a wide window shows no wide empty band; pages whose sections are independent (Members and Roles, Devices and Displays) place them side by side from 80 rem of container width (`settings-pair`).

### 7.3 Settings shell

- ≥ 1024: entering settings (from More, the person menu, a link) swaps the app sidebar for the **settings list**: `‹ Back to FamilyOS`, `Settings` 20/800, a search field (`/`), the four groups as nav rows (36 px, styled like the app sidebar), the person at the foot. The content column is the settings frame (`<Page template="settings">`, §3.2) with the page head (§3.5). Back returns to the page you came from, or Today.
- < 1024: More is the settings root (§7.4); each group is a page of rows; each settings page has a Back button. The tab bar stays visible in settings, so the person can leave in one tap.
- Search filters the list rows as you type; Enter opens the first match. It is a list filter, not a full-text index, with no backend.

### 7.4 More (phone)

Top to bottom: the person card (avatar, name, role, `profile, appearance, language` as the hint) → You; the family search box; **Household**: the pages with `placement: 'more'` as a 2-column grid of 56 px tiles with a disc and label, including Board and Assistant when they overflow the tab bar; **Settings**: three rows `Family`, `AI`, `System`, each with a one-line summary of the pages the person may open; `Sign out`. The bell is on Today, not here.

### 7.5 Tablet rail

The rail of §7.1. Settings on a tablet use the phone's page stack inside the content area; the rail stays.

## 8. Themes and tokens

**The tokens are the theme contract.** Every colour, the radius, the shadow and the font slots are tokens; components use only them (`bg-wall`, `bg-surface`, `bg-idle`, `text-ink-soft`, `bg-attention`, …), and a test fails on a hard-coded colour. A theme pack changes only token values, so interaction, layout and navigation hold in every theme. Names and meanings are in `@famos/themes` (`MODE_TOKENS`, `SHARED_TOKENS`, `CONTRAST_RULES`) and listed in the [appearance guide](../guide/appearance.md); the defaults are the Ev Işığı pack, `themes/ev-isigi/tokens.json`, mirrored by `packages/ui/src/theme.css` (a test keeps them equal). A new token needs a default there, an entry in the token list and a line in the guide.

- **Surfaces**: `wall` (the page), `surface` (raised, active, important), `idle` (receded), `ink` and `ink-soft` (text), `line` (borders).
- **State**: `attention` (needs someone: waiting suggestions, overdue), `now` (happening now, done), `sun` (weather, reminders, a soft highlight), `info` (information, the focus ring), `heat` (an upcoming deadline), `destructive`; `on-color` is text on the filled state colours.
- **The accent**: `accent` and `on-accent`, the one saturated surface (principle 1), ≥ 4.5:1 in `CONTRAST_RULES`.
- **Areas with their own look**: the board and its note papers (`board`, `board-grain`, `note-1` to `note-5`, `note-ink`, `note-ink-soft`, `note-tape`), photos (`scrim`, `backdrop`) and the weather sky (`sky-cloud`, `sky-flake`).
- **Shared**: `radius`, `shadow-lit`, and the font slots `font` (body), `font-display` and `font-serif` (empty means the style's default).

**Member colours** (`MEMBER_COLORS` in core) are assigned in order and kept away from coral and red, so a person never looks like a warning. Letters on a member colour (the initial in `Avatar`) are white or the day ink, whichever contrasts more (`onMemberColor`), and every palette colour is tuned so that choice reaches 4.5:1; `scripts/member-colors.test.ts` guards the palette. Colours an admin picks get the same choice, but mid-tones can fall short, so the picker stays in that range. Member colours are day colours: draw them inside `.day`. They mark people only: avatars, rings, rules, bars and a light tint behind `ink` text; never a surface, text or the hero.

- **Styles are code, not tokens:** the type ramp and the default font per slot belong to the style (`STYLES` in `@famos/ui`, `styles.css`), set on the document as `data-style` before first paint like the palette. A pack may fill the font slots and suggest a style (`style` in its manifest, used only while the family has never chosen one); it can never change a size or the arrangement.
- The derived values (`shadow-pop`, the sheet shadow, the 35 % scrim behind sheets) are constants composed in `theme.css`, not pack tokens.
- Tints are `color-mix(in oklab, var(--state) 15%, transparent)`. Text on a tint is the state colour mixed toward `ink` (§5.7): across the bundled packs, day and night, that gives ≥ 5.5:1 for `attention`/`now`/`info` at 65/35 and ≥ 4.9:1 for `heat`/`sun` at 50/50, while the pure state colour on its own tint drops to 3.6–4.4:1 and is not allowed. Pure `attention`/`now`/`info` text is used only on `wall`/`surface`/`idle`, which `CONTRAST_RULES` checks; `packages/themes/test/pill-contrast.test.ts` computes the mixes for every bundled pack.
- The shadcn variable names map onto the tokens for the vendored components.
- High contrast sets `shadow-lit: 0 0 0 1px`, turning tiles into outlined boxes, as intended.

## 9. Accessibility

- Targets 44 px on phones and tablets, 52 on the family display; 40 px on desktop, with a 44 px hit area through padding on icon buttons.
- Focus rings `info` everywhere; focus is trapped in dialogs, moved into panels/sheets and returned; menus are `role="menu"` with arrow keys; segmented controls are `radiogroup`.
- Every row with an action is a `button` or `a`, never a `div` with a click handler; the `⋯` has an `aria-label` naming the item.
- Colour is never the only signal: overdue says `Yesterday`, done has the check and the strike, selected has `aria-current`.
- Live regions: the toast is `role="status"`; counts in section labels are plain text; the quiet line is `aria-live="polite"`.
- Contrast: all text `ink`/`ink-soft` on `wall`/`surface`/`idle`; state text ≥ 13/700; `on-color` on `attention`/`now`/`info` fills only.
