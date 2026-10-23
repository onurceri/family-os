# Family members, roles and devices

Each person has a **role** that sets what they can do. Sign-in is separate: email and password (any device), PIN (only on a family device), or both. Admins only.

## Add people

1. **Settings → Family → Members** → **Add a member**.
2. Fill in:
   - **Name**: up to 60 characters. A name already in use asks "Someone in the family is already called Nina. Add anyway?"; press again to save. The AI asks which one rather than guess, so give them a short **About**.
   - **Role**: see [Roles](#roles).
   - **About (optional)**: up to 300 characters ("9 years old, at primary school"); helps the AI decide whom something is for. Hide it with **Send names and descriptions** ([AI and privacy](ai.md)).
   - **Sign-in**: **Email** and **Password** (10+ characters), **PIN** (4-6 digits), or both. Empty: add later.
3. **Save**. The page confirms; a later sign-in change says "Sign-in saved.".

Rows say how each person signs in: "Email and password", "PIN on family devices", "Email and password, and a PIN", "No sign-in yet".

**Edit** changes name, role, **About** and sign-in; empty fields keep the current value.

**Good to know**
- A new PIN or password signs that person out everywhere (an admin changing their own stays signed in).
- An email used by another member is refused (a new person is kept; try another email).
- The last admin cannot change role or be removed ("There must always be one admin.").
- Everyone picks their language under **Settings → You → Profile & sign-in** ([Languages](languages.md)).

### Remove a member

**Edit** → **Remove from the family** → tap again. Their password or PIN, sessions, access tokens and Telegram link end; they leave the list and sign-in page; the email is free again. What they added stays. No undo: add them again as new.

## Roles

| Role | For | Can do |
|---|---|---|
| Admin | Whoever runs FamilyOS (several allowed) | Everything. Only admins manage members, roles, devices, features, AI, auto-approval, backups, Telegram, email, languages, region, calendar subscriptions, display content |
| Member | Adults | See and change all else, approve suggestions, ask the assistant, connect own [AI apps](mcp.md) |
| Supervised | Children, or anyone to be checked | See everything. Directly: add and tick off shopping items, tick off tasks and own chores, post on the board, share to Quick add, ask the assistant (can keep notes for them). No app-key AI apps unless an admin allows it in **Roles**. Own things (shopping items, tasks made for themselves, board notes, own chore tick that day) they can also change or remove. Other people's things, and new events, become suggestions for someone who may approve (Admins and Members by default): the form says "After you save, someone has to approve this.", the button reads **Send for approval**, then "Sent for approval" |
| Guest | Babysitter, visiting grandparents | Look only: calendar, lists, chores, recipes, records, vehicles, home, pets. No sharing, suggesting or assistant |

Everyone sees their own notifications and the other members.

**Good to know**
- **Settings → Family → Roles** (or **What can each role do?**) lists permissions per role; a lock marks admin-only ones.
- Buttons appear only when allowed. Look-only pages show a **View only** mark instead of the add button, and non-working check circles are plain marks. Tapping it says: "Your role lets you see this. Mara and Tom can change what your role may do." Empty pages do not invite adding. Quick add links appear only for people who may use it.
- Menus list only pages your role may open. Another page says "This page is for people who may use Members" with a way back to Today.
- Refusals (role changed while open) say: "Your role does not allow this. Ask someone who looks after it in your family.", "This needs someone's approval, and your role cannot send suggestions. Ask someone who looks after it in your family to do it.", or, on a display, that it only shows things.
- A PIN sign-in can do all its role allows except admin-only things (people, roles, devices, features, AI, settings); admins use email and password for those.

### Your own roles

1. **Settings → Family → Roles** → **Your own roles** → **New role from Member**, **Supervised** or **Guest**.
2. Set a **Name**; tick or untick permissions.
3. **Create role**. Edit later: press its name at the top of the table, then **Save**.

Example: a Member who cannot approve others' suggestions: **New role from Member**, untick **Approve suggestions**.

**Good to know**
- Features added later follow the role you started from.
- Admin-only permissions cannot be given.
- Whatever a role may add, its people can take back when they added it, even without **Suggest changes for approval** (a Guest role with **Add and tick off shopping items** can delete its own items, not others').
- **Sign in with a PIN on family devices** is a permission (all built-in roles have it). Unticked: their PINs stop working and no PIN is offered.
- **Delete role**: tap again (**Tap again to delete**); only when nobody has it.

## Family devices and PINs

PINs work only on a **family device**, a tablet or phone an admin marked. Elsewhere only email and password work, and the sign-in page shows no names.

### Mark a device

1. Open FamilyOS on the device and sign in as admin (on first setup tick **This device is shared at home** instead).
2. **Settings → Family → Devices** → **Add a device** → **A tablet or phone the family shares**. At **Make it a family device**, enter a **Device name** ("Kitchen tablet") and press **Make this a family device** (also under **This device** at the top).
3. Sign out.

A browser cookie remembers it; clearing site data forgets it.

### Sign in on a family device

1. **Who's using FamilyOS?** lists people with a PIN. Tap a name.
2. Enter the PIN, press the check mark (✓, read as **Sign in**).
3. Adults: **Sign in with email** below the names (only form shown if nobody has a PIN).

A PIN sign-in lasts while the device is a family device and the role allows PINs.

### Stop a device

- On the device: **Settings → Family → Devices** → **Stop using** under **This device**. Like **Remove**: it leaves the list, everyone signed in there with a PIN is signed out, the sign-in page shows only email.
- From an admin's device: tap it under **The family's devices** → **Remove** → **Tap again to remove**. Stops at once. Do this for lost, sold or given-away tablets.

**Sign out** (person menu at the side bar's foot, or **More** on phones) ends this device's sign-in. **Sign out everywhere** ends all devices and also stops your app keys and calendar addresses. A new password or archiving you does the same.

### Sign-in limits

| What | Limit | Then |
|---|---|---|
| Wrong PINs, one person | 5 | Locked 15 minutes on any device, even with the right PIN: "Too many wrong PINs. Try again in 15 minutes." Only wrong PINs count (not right ones or refusals on non-family devices) |
| Wrong passwords, one person, same internet address | 5 | That address waits 15 minutes: "Too many wrong attempts. Try again in 15 minutes." Others, and the person elsewhere, unaffected |
| Wrong passwords, one person, many places | 20 per hour | Password refused for an hour on unknown devices; previously signed-in browsers and family devices still work |
| Wrong PINs, one device, anyone | 10 per minute | "Too many tries from this device. Wait 1 minute and try again." Right PINs do not count |

- Wrong passwords from elsewhere cannot lock you out of a device you signed in on before.
- A restart clears all locks. Waits shown come from the server.

## Displays

A wall display cannot sign anyone in or change anything. **Add a device** → **A screen for the wall or a TV**; manage on **Settings → Family → Devices**. See [Family displays](displays.md).
