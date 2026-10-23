# Calendars

Show your family calendar in the calendar app on your phone, and show other calendars (school, holidays, Google, iCloud) inside FamilyOS. Both are read-only: change events in FamilyOS (see [Everyday use](everyday.md)) or in the original calendar.

## The calendar on your phone

Addresses can only be made after signing in with your password, not with a PIN on a shared family device. An address stops working when the person who made it signs out everywhere, gets a new password, is archived or loses the right to see the calendar (for a whole-family address, to manage it).

1. Open **Settings → You → Calendar on my phone**, section **Calendar on your phone**.
2. **What to show:** **My events** or **The whole family**. Only admins see this choice; for everyone else the address shows their own events.
3. Turn on **Include notes** to get event notes too. Titles, times and places are always included.
4. Optionally write **Where will you use it?** (for example "Mum's phone") to tell addresses apart later.
5. Press **Create address**.
6. The address is shown **only once**. Press **Copy address**, or **Open in the calendar app** on a phone. Then press **I have saved it**.
7. Add it to your phone:
   - **iPhone:** Settings, Calendar, Accounts, Add account, Other, Add subscribed calendar.
   - **Android with Google Calendar:** open calendar.google.com on a computer, Other calendars, From URL.

**Good to know**
- Your phone refreshes the calendar by itself, usually every few hours.
- **Anyone who has the address can read these events, without signing in.** Treat it like a password. If it gets out, press **Remove** (twice) in **Your addresses** and make a new one. A removed address stops working at once. The list shows when each address was last used.
- This page sends the family calendar out. Bringing one in is done under **Settings → Family → Calendars & tags** by whoever manages the family's calendars (admins by default); this page links there for those who may use it.
- The address carries tags as categories.

## Subscribe to other calendars

You need the permission to manage the calendar (admins have it). Any calendar with an ICS or webcal address works:

| Calendar | Where to get the address |
|---|---|
| School or club | Ask for the "ICS" or "iCal" link. |
| Public holidays | Many countries publish one. |
| Google Calendar | On a computer: the calendar's settings, **Integrate calendar**, copy the **Secret address in iCal format**. |
| iCloud | In the Calendar app share the calendar, turn on **Public Calendar**, copy the link. |

1. Open **Settings → Family → Calendars & tags**, section **Calendar subscriptions**.
2. Enter a **Name** and the **Calendar address**, choose a **Colour**, and optionally **Whose is it?** (**Whole family**, the first choice, until you pick someone).
3. Press **Add subscription**.

**Good to know**
- Addresses from Google and iCloud are secret: FamilyOS keeps them encrypted and never shows them again.
- Subscribed events show in the color you chose and cannot be edited. Tags from the subscribed calendar show on its events.
- **Edit** renames, recolors, changes the people or options, or gives a new address (leave **New calendar address (optional)** empty to keep the current one).
- FamilyOS fetches the calendar every 6 hours; **Refresh now** does it immediately.
- If a calendar cannot be reached, earlier events stay and the reason is shown on the subscription. If it says the address cannot be used, press **Edit** and enter the address again.
- **Remind about its events** sends the usual reminders for that calendar. Leave it off for calendars you only look at.
- **Calendar on my home network** is for a calendar inside your own network, such as on a NAS. Normally addresses into private networks are refused, so an address cannot be used to reach other devices at home. Leave it off for anything on the internet.
- **Remove** (twice) deletes a subscription and its events disappear from FamilyOS.

## Tags

Give an event up to 5 tags, such as school, health or car: **Tags** in the event form (press Enter or a comma to add one, or pick one you used before). Tags are colored and every event shows them.

**Good to know**
- On the calendar, tap one or more tags to show only those events; **All** shows everything again. The choice is remembered on that device.
- People who can change events can rename, recolor or delete tags under **Phone and other calendars**, then **Tags**. Renaming or deleting changes every event with the tag; renaming to an existing name merges the two.

## Reminders

Every event has a **Reminder** field. Default: 30 minutes before a timed event, 09:00 on the day for an all-day event.

| Event | Choices |
|---|---|
| Any | **No reminder**, at the start, 5, 10, 15 or 30 minutes, 1 or 2 hours or 1 day before |
| All-day | Also 09:00 on the day or 21:00 the evening before |

Repeating events remind before each occurrence. Reminders arrive as notifications to the people chosen under **Who**, or to everyone who can see the calendar if you chose nobody; see [Notifications](notifications.md).
