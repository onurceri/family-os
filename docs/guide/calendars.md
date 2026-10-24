# Calendars

Show the family calendar in your phone's calendar app, and bring other calendars (school, holidays, Google, iCloud) into FamilyOS. Both are read-only: change events in FamilyOS ([Everyday use](everyday.md)) or in the original.

## The calendar on your phone

Needs a password sign-in, not a PIN. An address stops when its maker signs out everywhere, gets a new password, is archived or loses calendar access (whole-family: loses manage).

1. **Settings → You → Calendar on my phone**, section **Calendar on your phone**.
2. **What to show:** **My events** or **The whole family** (admins only choose; others get their own events).
3. **Include notes** adds event notes (titles, times, places are always included).
4. Optionally **Where will you use it?** ("Mum's phone").
5. **Create address.**
6. It is shown **once**: **Copy address**, or **Open in the calendar app** on a phone; then **I have saved it**.
7. Add it:
   - **iPhone:** Settings, Calendar, Accounts, Add account, Other, Add subscribed calendar.
   - **Android with Google Calendar:** calendar.google.com on a computer, Other calendars, From URL.

**Good to know**
- Phones refresh by themselves, usually every few hours.
- **Anyone with the address reads these events without signing in.** Treat it like a password. If it leaks, **Remove** (twice) in **Your addresses** and make a new one; removal works at once. The list shows last use.
- Tags go out as categories.
- Bringing calendars in is under **Settings → Family → Calendars & tags**, for whoever manages calendars (admins by default); this page links there.

## Subscribe to other calendars

Needs permission to manage the calendar (admins have it). Any ICS or webcal address works:

| Calendar | Address from |
|---|---|
| School, club | Ask for the "ICS" or "iCal" link. |
| Public holidays | Many countries publish one. |
| Google | Computer: calendar settings, **Integrate calendar**, **Secret address in iCal format**. |
| iCloud | Share the calendar, turn on **Public Calendar**, copy the link. |

1. **Settings → Family → Calendars & tags → Calendar subscriptions.**
2. Enter **Name** and **Calendar address**, choose **Colour**, optionally **Whose is it?** (**Whole family** until you pick someone).
3. **Add subscription.**

**Good to know**
- Google and iCloud addresses are secret: stored encrypted, never shown again.
- Events show in your color, cannot be edited, and keep their tags.
- **Edit** changes name, color, people, options or address (empty **New calendar address (optional)** keeps the current one).
- Fetched every 6 hours; **Refresh now** at once.
- If unreachable, old events stay and the subscription shows why. If it says the address cannot be used, **Edit** and re-enter it.
- **Remind about its events** sends usual reminders; leave off for look-only calendars.
- **Calendar on my home network** allows an address inside your network (a NAS). Otherwise private addresses are refused so addresses cannot probe your home devices. Off for internet calendars.
- **Remove** (twice) deletes the subscription and its events.

## Tags

Up to 5 per event (school, health, car): **Tags** in the event form, Enter or comma to add, or pick an earlier one. Tags are colored and shown on every event.

**Good to know**
- On the calendar tap tags to filter; **All** resets. Remembered per device.
- Editors rename, recolor or delete under **Phone and other calendars → Tags**. This changes every event with the tag; renaming to an existing name merges.

## Reminders

Each event has a **Reminder**; default 30 minutes before (timed) or the family's [reminder time](region.md) on the day (all-day, 09:00 unless changed).

| Event | Choices |
|---|---|
| Any | **No reminder**, at start, 5, 10, 15, 30 minutes, 1 or 2 hours, 1 day before |
| All-day | Also 12 hours before the reminder time |

Repeating events remind before each occurrence. They go to the people under **Who**, or everyone who sees the calendar if none ([Notifications](notifications.md)).
