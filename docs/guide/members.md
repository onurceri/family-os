# Family members, roles and devices

Everyone in the household gets a place in FamilyOS with a role. The role decides what they can do. How they sign in is up to you, whatever their role: with an email and a password (on any device), with a PIN (only on a tablet or phone you have marked as a family device), or both.

Only admins can do what is on this page.

## Add people

Open **Settings → Family → Members** press **Add a member** and fill in the panel:

- **Name**: up to 60 characters.
- **Role**: see below. A short note under the field says what the role is for.
- **About (optional)**: a few words such as "9 years old, at primary school" or "Deniz's partner". It helps the AI decide whom a school notice or an appointment is for. You can stop the AI from seeing it with **Send names and descriptions** (see [AI and privacy](ai.md)). Up to 300 characters.

- **Sign-in**: how this person signs in. Give an **Email** and a **Password** (at least 10 characters), a **PIN** (4 to 6 digits), or both. A teenager with their own phone gets an email and password; a young child on the kitchen tablet gets a PIN. Leave them empty to add a sign-in later.

Press **Save**. The page shows "Sign-in saved." when a sign-in was given. Each row says how that person really signs in: "Email and password", "PIN on family devices", "Email and password, and a PIN", or "No sign-in yet".

**Edit** (on a row) changes a person's name (up to 60 characters), role and **About** text, and their sign-in: the panel says what they have now, and fields you leave empty keep it. Setting a new PIN or password signs that person out on every device, so they sign in again with the new one. An admin who changes their own password stays signed in. If another member already uses that email, the page says so (a new person is then kept, and you can try another email). At least one admin must stay: the last admin cannot be given another role, and the page says "There must always be one admin."

### Remove a member

Press **Edit** on their row, then **Remove from the family** and tap again to confirm. They cannot sign in any more: their password or PIN, sessions, access tokens and Telegram link end, they disappear from the list and the sign-in page, and their email can be used again. What they added (events, tasks, records) stays. The last admin cannot be removed. There is no undo; add them again as a new member if needed.

Everyone chooses their own language under **Settings → You → Profile & sign-in**. See [Languages](languages.md).

## Roles

| Role | For | What they can do |
|---|---|---|
| Admin | Whoever runs FamilyOS (there can be several) | Everything. Only admins manage members, roles, devices, features, AI, auto-approval, backups, Telegram, email, languages and region, calendar subscriptions, display content. |
| Member | Adults | See and change everything else, approve suggestions, ask the assistant and connect their own [AI apps](mcp.md). |
| Supervised | Children, or anyone whose changes should be checked | See everything. Use the everyday things directly: add shopping items and tick them off, tick off tasks and their own chores, post on the board, share to Quick add and ask the assistant, which can keep notes for them. They cannot connect outside AI apps with an app key (an admin can allow that in **Roles**). What they added themselves they can also change or remove directly: their own shopping items, the tasks they made for themselves, their own board notes, and their own tick on a chore that day. Changing or removing other people's things, or a new event, becomes a suggestion that someone who may approve suggestions (Admins and Members by default) decides. Forms say so before they save ("Saving sends this for approval."), and after saving the page says "Sent for approval". |
| Guest | A babysitter, grandparents visiting | Look only: the calendar, lists, chores, recipes, records, vehicles, home and pets. No sharing, suggesting or assistant. |

Everyone also sees their own notifications and the other members.

Menus show only the pages your role may open. If you follow a link or a bookmark to one that is not for you, the page says so ("This page is for people who may use Members") and offers the way back to Today.

Any role can sign in with an email and password, a PIN, or both. Someone who signs in with a PIN can do everything their role allows except what only admins may do: an admin signed in with a PIN cannot manage people, roles, devices, features, AI or settings. For that, they sign in with their email and password.

**Settings → Family → Roles** (or **What can each role do?** on the members page) shows every permission and which role has it. A lock marks what only admins can have.

### Your own roles

Need something in between? On **Settings → Family → Roles**, under **Your own roles**, press **New role from Member**, **New role from Supervised** or **New role from Guest**. Give it a **Name**, tick or untick single permissions and press **Create role**. To change a role later, press its name at the top of the table, then **Save**.

- Things added to FamilyOS later follow the role you started from.
- Admin-only permissions cannot be given to a custom role.
- **Sign in with a PIN on family devices** is one of the permissions. Every built-in role has it. Untick it for a custom role whose people should only use an email and password: their PINs then stop working, and the members page offers no PIN for them.
- Example: a teenager who uses everything like a Member but should not approve other people's suggestions. Press **New role from Member**, give it a name, untick **Approve suggestions** and press **Create role**.
- **Delete role** needs a second tap (**Tap again to delete**). It only works when nobody has the role.

## Family devices and PINs

A PIN is short, so it only works where nobody can try it from the internet: on a **family device**. That is a tablet or phone that an admin marked. On every other device only the email and password work, and the sign-in page never shows names.

### Mark a device

1. Open FamilyOS in the browser of the tablet or phone and sign in as an admin. (On first setup you can tick **This device is shared at home** instead.)
2. Open **Settings → Family → Devices**, press **Add a device** and choose **A tablet or phone the family shares**. At the step **Make it a family device**, give it a **Device name** such as "Kitchen tablet" and press **Make this a family device**. (The **Make this a family device** button under **This device** at the top of the page opens the same step.)
3. Sign out.

The device is now remembered by a cookie in that browser. Clearing the browser's site data forgets it, and you mark it again.

### Sign in on a family device

The sign-in page asks **Who's using FamilyOS?** and shows the people who have a PIN. Tap a name, enter the PIN on the number pad and press **Sign in**. Adults press **Sign in with email** below the names. If nobody uses a PIN, only the email form is shown.

A PIN sign-in lasts only as long as the device is a family device and the person's role still allows PINs.

### Wrong PINs

After 5 wrong PINs for one person, that person cannot sign in for 15 minutes, even with the right PIN, on any device. The screen says "Too many wrong PINs. Try again in 15 minutes." (the wait comes from the server). The same limit applies to a wrong email or password, with its own message. Only a wrong PIN counts: signing in with the right one, or a refusal on a device that is not a family device, does not. Restarting FamilyOS clears the lock.

One device can also send at most 10 wrong PINs a minute, for anyone. After that the screen says "Too many tries from this device. Wait 1 minute and try again." Children switching profiles on the kitchen tablet never reach it, because right PINs do not count.

### Stop a device

- On the device itself, **Settings → Family → Devices**, then **Stop using** under **This device**, revokes the device and removes the mark from this browser, the same as **Remove** below: it leaves the list, and everyone who signed in there with a PIN is signed out. The sign-in page then shows only the email form.
- From any admin's device, tap it under **The family's devices** and press **Remove**, then **Tap again to remove**. It stops working at once and everyone who signed in there with a PIN is signed out. Do this when a tablet is lost, sold or given away.

**Sign out** (in the person menu at the foot of the side bar, or under **More** on a phone) ends your sign-in on this device. **Sign out everywhere** ends it on every phone, tablet and browser.

## Displays

A wall display is a device too, but it cannot sign anyone in and cannot change anything. It is added (**Add a device**, then **A screen for the wall or a TV**) and managed on the same **Settings → Family → Devices** page. See [Family displays](displays.md).
