# Notifications

FamilyOS tells people when something needs them. Everything is listed in the app; phone notifications and Telegram are optional copies.

## What you are told about

- **Suggestions waiting for approval.** When a supervised member shares something to Quick add and the AI proposes changes, or a supervised member suggests a change by hand, the people who may approve are told who asked and what it is (**Leo: Change an event: Piano lesson**). Several suggestions from one shared item arrive as one notification, after about half a minute. You are never told about your own suggestions, and what you share yourself is for you alone to decide, so other adults are not told about it. Opening the notification takes you to Quick add.
- **Answers to your suggestions.** When someone else approves or rejects a suggestion of yours, you are told who and what (**Mara said no to your suggestion**, **Change an event: Piano lesson**). Suggestions from one shared item decided together arrive as one notification. Nothing comes when you take a suggestion back yourself, or when auto-approval approves it.
- **Something you shared has been read.** When you share from outside the app (the share sheet, Telegram or email) and the AI has suggestions, you get one notification, with the approve and reject buttons on Telegram. Using the Quick add page sends nothing.
- **Event reminders.** Before a calendar event, for the people it is for (everyone who can see the calendar when it is for nobody in particular). By default a timed event reminds 30 minutes before, an all-day event at 09:00 on the day. Change it per event in the **Reminder** field. See [Calendars](calendars.md).
- **Task due dates.** A task with a due date reminds whoever it is assigned to (everyone who can see lists when nobody is), at its due time, or at 09:00 when it has no time.
- **Chores.** On the day a chore is due, at 09:00, the person whose turn it is is told. A chore that anyone may do reminds nobody. See [Chores](chores.md).
- **Duties.** Something that needs doing (a renewal, a service) reminds its assignee, or everyone who can see records when nobody is assigned, a number of days before and again on the due day, at 09:00. See [What needs doing and Papers](records.md).
- **A backup could not be sent off the server.** Admins only. See [Backups](backups.md).
- **Auto-approval stopped.** Admins only. See [Auto-approval](auto-approval.md).

Reminder times follow the family's time zone (see [Region and formats](region.md)).

## The list in the app

On a computer or tablet, the **bell** at the top of the navigation shows how many notifications you have not read; press it to see the latest ones, **Mark all read**, or open one. On a phone, the bell is at the top of **Today**; it opens the full list (also under **Settings → You → Notifications**, where the number on **More** counts what you have not read). Tap a notification to mark it read and go to the thing it is about. **Mark all as read** clears the count.

Each person has their own list, in their own language.

## Notifications on a phone or computer

Under **Settings → You → Notifications → This device** (the **Settings** link in the bell's popover leads there too), press **Turn on notifications on this device** and allow it when the browser asks. The device then gets notifications even when FamilyOS is closed. **Send a test notification** checks that it works. **Turn off notifications on this device** stops them on this device only. Your devices are listed under **Devices with notifications**.

- **iPhone and iPad.** Notifications only work from the app on the Home Screen. In Safari tap Share, then **Add to Home Screen**, open FamilyOS from there, and turn them on. This needs iOS 16.4 or newer.
- **Android, Windows, macOS, Linux.** Chrome, Edge, Firefox and Safari work. Use the installed app if you installed it.
- Browsers only allow this over HTTPS; see [HTTPS and phones](https.md). If you pressed "Block" once, allow notifications for the site in your browser or system settings, then reload.

If you already read a notification in the app before it would be sent to your phone, it is not sent.

## Quiet hours

Switch on **Quiet hours** and choose **From** and **Until** (the default is 22:00 to 07:00). In that time nothing is sent to phones or Telegram. The notifications still appear in the list, and anything you have not read by the time quiet hours end is sent then. Quiet hours that cross midnight work as you would expect, and they follow the family's time zone.

## What goes where

Under the quiet hours, every kind of notification has a switch for each way of receiving it (**Phone notifications** once a device has them turned on, and **Telegram** once you linked it). Turn off what you do not want. Your choices are yours alone. Without a phone or Telegram turned on, the page only says that notifications appear here in the app.

Kinds you can never receive, such as the backup message for people who are not admins, are not listed.

## Telegram

Telegram can deliver the same notifications, with buttons to approve or reject suggestions. See [Telegram](telegram.md).
