# Calendars

FamilyOS can show your family calendar in the calendar app on your phone, and can show other calendars (school, holidays, Google, iCloud) inside FamilyOS. Both are read-only: you change events in FamilyOS (see [Everyday use](everyday.md)), or in the original calendar.

## The calendar on your phone

Open **Settings → You → Calendar on my phone**. Addresses can only be made after signing in with your password, not with a PIN on a shared family device. An address stops working when the person who made it signs out everywhere, gets a new password, is archived or loses the right to see the calendar (for a whole-family address, to manage it). Under **Calendar on your phone**:

1. **What to show:** **My events** or **The whole family**. Only admins see this choice; for everyone else the address shows their own events.
2. Turn on **Include notes** if you want event notes in your phone too. Titles, times and places are always included.
3. Optionally write **Where will you use it?** (for example "Mum's phone"), so you can tell addresses apart later.
4. Press **Create address**.

The address is shown **only once**. Copy it (**Copy address**), or press **Open in the calendar app** on a phone. Then **I have saved it**.

- **iPhone:** Settings, Calendar, Accounts, Add account, Other, Add subscribed calendar.
- **Android with Google Calendar:** open calendar.google.com on a computer, Other calendars, From URL.

Your phone refreshes the calendar by itself, usually every few hours.

This page sends the family calendar out. Bringing a calendar from outside in (holidays, school) is done under **Settings → Family → Calendars & tags** by whoever manages the family's calendars (admins by default); the page says so, and shows that link to those who may use it.

**Anyone who has the address can read these events, without signing in.** Treat it like a password. If it gets out, press **Remove** (twice) in **Your addresses** and make a new one. A removed address stops working at once. The list shows when each address was last used.

## Subscribe to other calendars

Open **Settings → Family → Calendars & tags** (you need the permission to manage the calendar; admins have it). Under **Calendar subscriptions** you can add any calendar that has an ICS or webcal address:

- a school or club calendar (ask them for the "ICS" or "iCal" link);
- public holidays (many countries publish one);
- **Google Calendar:** on a computer open the calendar's settings, then **Integrate calendar**, and copy the **Secret address in iCal format**.
- **iCloud:** in the Calendar app share the calendar and turn on **Public Calendar**, then copy the link.

Enter a **Name** and the **Calendar address**, choose a **Colour** and, if you like, **Whose is it?** (**Whole family**, the first choice, until you pick someone), then press **Add subscription**. Addresses from Google and iCloud are secret; FamilyOS keeps them encrypted and never shows them again.

Subscribed events appear in FamilyOS in the color you chose and cannot be edited. Press **Edit** on a subscription to rename it, change the color, the people or the options, or give it a new address (leave **New calendar address (optional)** empty to keep the current one). FamilyOS fetches the calendar again every 6 hours; **Refresh now** does it immediately. If a calendar cannot be reached, the events from before stay and the reason is shown on the subscription. If it says the address cannot be used, press **Edit** and enter the calendar address again.

**Remind about its events** sends the usual reminders for that calendar's events. Leave it off for calendars you only want to look at.

**Calendar on my home network** is for a calendar inside your own network, such as on a NAS. Normally FamilyOS refuses addresses that point into private networks, so that an address cannot be used to reach other devices at home. Leave this off for anything on the internet.

Press **Remove** (twice) to delete a subscription. Its events disappear from FamilyOS.

## Tags

Give an event up to 5 tags, such as school, health or car (**Tags** in the event form; press Enter or a comma to add one, or pick one you used before). Tags are colored, and every event shows them. On the calendar, tap one or more tags to show only those events; **All** shows everything again, and your choice is remembered on that device. People who can change events can rename, recolor or delete tags under **Phone and other calendars**, then **Tags**: renaming or deleting changes every event that has the tag, and renaming a tag to a name that exists merges the two. The calendar address on your phone carries the tags as categories, and tags from a subscribed calendar show on its events.

## Reminders

Every event has a **Reminder** field. The default is 30 minutes before for a timed event, and 09:00 on the day for an all-day event. You can choose **No reminder**, at the start, 5, 10, 15 or 30 minutes, 1 or 2 hours or 1 day before, and for all-day events 09:00 on the day or 21:00 the evening before. Repeating events remind before each occurrence.

Reminders arrive as notifications to the people chosen under **Who**, or to everyone who can see the calendar if you chose nobody; see [Notifications](notifications.md).
