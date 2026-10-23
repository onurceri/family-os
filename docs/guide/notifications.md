# Notifications

FamilyOS tells people when something needs them. Everything is listed in the app; phone notifications and [Telegram](telegram.md) (same notifications, with approve and reject buttons) are optional copies.

## What you are told about

| Kind | Who | When and what |
|---|---|---|
| Suggestions waiting for approval | The people who may approve | A supervised member shares to Quick add and the AI proposes changes, or suggests a change by hand. You see who asked and what (**Leo: Change an event: Piano lesson**). Suggestions from one shared item arrive as one notification after about half a minute. Opening it goes to Quick add. |
| Answers to your suggestions | The one who suggested | Someone else approves or rejects it (**Mara said no to your suggestion**, **Change an event: Piano lesson**). Suggestions from one item decided together arrive as one. |
| Something you shared has been read | The one who shared | You shared from outside the app (share sheet, Telegram or email) and the AI has suggestions. Telegram adds approve and reject buttons. |
| Event reminders | The people the event is for (everyone who can see the calendar when it is for nobody in particular) | A timed event 30 minutes before, an all-day event at 09:00 on the day. Change it per event in the **Reminder** field. See [Calendars](calendars.md). |
| Task due dates | The assignee (everyone who can see lists when nobody is) | At the due time, or 09:00 when it has no time. |
| Chores | The person whose turn it is | At 09:00 on the day a chore is due. A chore anyone may do reminds nobody. See [Chores](chores.md). |
| Duties (a renewal, a service) | The assignee, or everyone who can see records when nobody is | A number of days before and again on the due day, at 09:00. See [What needs doing and Papers](records.md). |
| A backup could not be sent off the server | Admins only | See [Backups](backups.md). |
| Auto-approval stopped | Admins only | See [Auto-approval](auto-approval.md). |

**Good to know**
- You are never told about your own suggestions, and what you share yourself is for you alone to decide, so other adults are not told about it.
- No answer comes when you take a suggestion back yourself, or when auto-approval approves it.
- Using the Quick add page sends no "has been read" notification.
- Reminder times follow the family's time zone (see [Region and formats](region.md)).

## The list in the app

- **Computer or tablet:** the **bell** at the top of the navigation shows how many you have not read. Press it for the latest ones, **Mark all read**, or to open one.
- **Phone:** the bell is at the top of **Today** and opens the full list (also under **Settings → You → Notifications**, where the number on **More** counts unread ones).
- Tap a notification to mark it read and go to the thing it is about. **Mark all as read** clears the count.
- A "suggestion to review" notification leaves the list once someone has decided the suggestion.
- Each person has their own list, in their own language.

## Notifications on a phone or computer

1. Open **Settings → You → Notifications → This device** (the **Settings** link in the bell's popover leads there too).
2. Press **Turn on notifications on this device** and allow it when the browser asks. The device then gets notifications even when FamilyOS is closed.
3. Press **Send a test notification** to check.

**Turn off notifications on this device** stops them on this device only. **Devices with notifications** lists your devices.

| Device | How |
|---|---|
| iPhone and iPad | Only from the app on the Home Screen: in Safari tap Share, **Add to Home Screen**, open FamilyOS from there, turn them on. Needs iOS 16.4 or newer. |
| Android, Windows, macOS, Linux | Chrome, Edge, Firefox and Safari work. Use the installed app if you installed it. |

**Good to know**
- Browsers only allow this over HTTPS; see [HTTPS and phones](https.md).
- If you pressed "Block" once, allow notifications for the site in your browser or system settings, then reload.
- A notification you already read in the app is not sent to your phone.

## Quiet hours

Switch on **Quiet hours** and choose **From** and **Until** (default 22:00 to 07:00). In that time nothing is sent to phones or Telegram. Notifications still appear in the list, and anything unread when quiet hours end is sent then. Quiet hours may cross midnight and follow the family's time zone.

## What goes where

Under the quiet hours, every kind has a switch for each way of receiving it: **Phone notifications** (once a device has them on) and **Telegram** (once linked). Turn off what you do not want; the choices are yours alone. Without either, the page only says that notifications appear here in the app. Kinds you can never receive (the backup message for non-admins) are not listed.
