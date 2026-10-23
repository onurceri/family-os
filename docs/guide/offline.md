# Using it offline

In a shop with poor reception, or on a phone that dropped off Wi-Fi, the small everyday taps still work. FamilyOS keeps them on the device and sends them when the connection is back.

## What works without a connection

- adding shopping items, and ticking them off or back on
- marking a task done, and putting it back
- marking a chore done, and taking that back

Everything else (editing a task, creating a chore, calendar, settings, assistant, Quick add) needs a connection; the app says when something failed. It opens offline only after one online visit on that phone, over HTTPS ([HTTPS and phones](https.md)).

## What you see

- The change shows at once with a small **Waiting to send** mark. A line at the top says how many changes are waiting.
- **Offline — showing what was last seen** appears with no connection or when the server does not answer; shopping lists, tasks, chores and the calendar days you looked at are as last opened.
- Waiting changes are sent in order and the marks disappear: on reconnect, on opening the app, and every 30 seconds while something waits (a repeatedly failing change is tried less often, up to every 10 minutes).

## When a change cannot be saved

If the family changed things meanwhile (an item someone removed, something you may no longer do), the change is dropped and listed at the top as **1 change could not be saved**, with what, when and why. Select the X (or **Dismiss all**).

Server-side problems (a restart) drop nothing: the change keeps waiting.

### Good to know

- Waiting changes stay in that device's browser, never a cloud, and hold only what you typed (an item name, which task), no passwords.
- Each change has a one-time key, so a lost answer or a double tap never applies twice.
- Changes belong to whoever made them. Signing out removes waiting changes, notices and saved list copies from that browser; another person on the phone never sends them. Sign out online if changes still wait, or they are discarded.
- Permissions and approval apply when the change reaches the server; one needing approval becomes a suggestion then.
- Wall displays do not queue anything.
