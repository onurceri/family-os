# Home Assistant

Show the FamilyOS calendar in [Home Assistant](https://www.home-assistant.io), and show Home Assistant's sensors, switches and who is home in FamilyOS.

> For Home Assistant's AI using FamilyOS, see [Bring your own agent (MCP)](mcp.md#home-assistant).

## Show the calendar in Home Assistant

Read-only: you change events in FamilyOS (see [Everyday use](everyday.md)), Home Assistant follows. It shows in its calendar panel, on dashboards and in automations ("porch light on when someone has an evening event"). Nothing extra is installed in FamilyOS; it uses the same address as the calendar on your phone.

1. In FamilyOS, create a calendar address ([Calendars](calendars.md#the-calendar-on-your-phone)): **Settings → You → Calendar on my phone**, choose **What to show**, press **Create address**, then **Copy address**. It is shown only once.
2. In Home Assistant, open **Settings → Devices & services → Add integration** and choose **Remote Calendar**.
3. Give the calendar a name, paste the address, and finish. A plain `http://` address works on your home network; `webcal://` is accepted too.

Repeating events, summer time changes, all-day and multi-day events, events past midnight and the place of an event come through correctly.

**Keep it up to date.** Home Assistant reads the address once a day, so a new event can take up to a day to show. Add an automation that reads it again, for example every 15 minutes (automation editor, or YAML):

```yaml
alias: Refresh the FamilyOS calendar
triggers:
  - trigger: time_pattern
    minutes: "/15"
actions:
  - action: homeassistant.update_entity
    target:
      entity_id: calendar.your_calendar_name
```

Replace `calendar.your_calendar_name` with the **Entity ID** under **Settings → Devices & services → Entities** (search for the name you gave the calendar).

**Keep it safe.** The address works like a password: anyone who has it can read the calendar without signing in. Home Assistant keeps it in its settings and so in its backups. If it gets out, press **Remove** (twice) next to it under **Your addresses** in FamilyOS, make a new one and put it into Home Assistant. The old one stops at once.

## Connect FamilyOS to Home Assistant

FamilyOS reads what you chose to show on Today and on the family display. It **never switches anything you did not allow**: a light, a lock or a cover is switched only after you turned that on for it, and only by people allowed to. Home Assistant cannot limit a token, so this is kept by what FamilyOS sends, not enforced by Home Assistant.

1. Install the extension: **Settings → Family → Extensions**, **⋯** menu → **Look for more**, download **Home Assistant** and install it ([Extensions](extensions.md)). It works after FamilyOS restarts. Only admins can connect it.
2. In Home Assistant, create a separate user, for example "FamilyOS", that is not an administrator, and sign in as it.
3. Open that user's **Profile → Security**, scroll to **Long-lived access tokens**, press **Create token** and copy it. It is shown only once.
4. In FamilyOS open **Settings → Family → Home Assistant**, press **Connect**, and fill in:
   - **Address**: for example `http://192.168.1.20:8123` or `https://ha.example.net`. Use the **IP address**: names ending in `.local` do not work from FamilyOS. A trailing `/` or `/api` is removed.
   - **Token**: the one you copied.
5. Press **Test connection**. It tries the address and token without saving and says "Connected to Home, version 2026.10.2", or what is wrong. After a good test press **Save**. After a failed one, fix the details and **Test again**, or **Save anyway** (for example when Home Assistant is off for now). Changing the address or token clears the result.

FamilyOS then checks the connection again and shows the address, Home Assistant's name and version, and the result. The token is kept sealed and never shown again, so **Change** asks for it again. **Disconnect** (**⋯** menu) makes FamilyOS forget the address and token; nothing changes in Home Assistant. If a token was ever exposed, delete it in Home Assistant too.

| Result | Meaning and fix |
|---|---|
| **Connected** | All is well. |
| **Token refused** | Home Assistant did not accept the token. Create a new one, choose **Change**. |
| **Not Home Assistant** | Something else answers there. Check the address and port (usually 8123). |
| **Address not allowed** | FamilyOS does not connect to that address (for example a special or link-local one). Use Home Assistant's address on your home network. |
| **Cannot be reached**, **No answer** | Is Home Assistant running, and is the address right? `.local` never works; use the IP address. |
| **Check failed** | Something else went wrong. **Check again**, or **Change**. |

## Show sensors on Today and on the display

When the connection says **Connected**, **What to show** appears on the same page.

1. Press **Add**. Search by name or id (such as `sensor.kitchen_temperature`) and choose it. If your home has too many things to list, type the id.
2. Give it a short name, up to 40 characters. It starts with Home Assistant's name.
3. Press **Save**.

**Good to know**
- Up to 12 things. Tap a row to rename, move up or down, or remove it. Disconnecting keeps the list.
- You can show sensors, doors and windows, lights, switches, locks, covers, thermostats, scenes and anything with a state. Showing a light or lock only shows its state; switching needs [its own permission](#switch-things-from-familyos).
- **People, their phones and places** are not offered here: where someone is is [their own choice](#who-is-home).
- Everyone who may see Home Assistant values sees them on Today, in a small section that can be hidden in **What Today shows**.
- A family display shows them when allowed in **Settings → Devices**. It can also show a whole screen: add the page **Around the house** under **Pages** in the screen's panel ([Family displays](displays.md#pages)). Two columns on a large screen; it says how many more when they do not all fit.
- Values are read live and are at most about a minute old. When Home Assistant cannot be reached, nothing is shown (no old value), and Today says nothing about it.
- Numbers keep Home Assistant's unit and follow your region's format. Doors, windows and covers read **Open** or **Closed**, locks **Locked** or **Unlocked**, motion **Detected** or **Clear**, smoke or a problem **Alert** or **OK**, lights and switches **On** or **Off**, a thermostat its mode and current temperature. A scene or button reads **Last run 22:10** (with the date when it was another day), or **Never run**. Anything else is worded as Home Assistant words it. No value reads **Not available**.

## Switch things from FamilyOS

Lights, switches, fans, on/off helpers (`input_boolean`), covers (blinds, windows, garage doors), locks, scenes and scripts can be switched from FamilyOS, one by one, when you allow it.

1. In **Settings → Family → Home Assistant**, under **What to show**, tap the thing.
2. Turn on **Can be switched from FamilyOS**. It starts off for everything.
3. Decide whether FamilyOS asks first. **Ask before switching** appears under the first switch and starts **off** for every item. Turn it on for anything that matters, such as a lock or garage door: FamilyOS then asks first, naming the thing and the action ("Unlock Front door?"). Things set up earlier keep their choice.
4. Press **Save**.

The row on Today and on this page then has a switch (lights, switches, fans), **Open** and **Close** (covers; **Stop** while one moves), **Lock** or **Unlock**, or **Run** (scenes, scripts). The value says **Switching…** until Home Assistant shows the new state, usually within seconds.

**Good to know**
- **Who may switch**: people whose role has **Switch things through Home Assistant**. At first only admins; give it to others under **Settings → Family → Roles**. Others see values but no switches.
- **Family displays never switch anything.** Neither do FamilyOS's assistant or connected AI apps ([MCP](mcp.md)): they cannot do it or suggest it.
- **The token can do more than FamilyOS lets anyone do.** Home Assistant has no token that may only switch some things, so it can switch and unlock everything its user can. FamilyOS asks only for what you allowed. Keep the token safe and the separate non-administrator user.
- **Switched lately** on **Settings → Family → Home Assistant** lists the last ten switches: "Tom turned on Living room light", "Mara ran Movie night", "Tom unlocked Front door". A failure reads "Could not switch Living room light", with who asked beside the time. Entries use the name the thing had then and stay after a rename or removal. Tapping a switchable thing shows its own last five. Entries are kept about three months. Everyone who can open the page sees them. A display not allowed to show names says "Someone".
- **When it does not work**, the person sees "Could not switch …". If the connection says **Token refused**, create a new token and **Change**. If Home Assistant no longer has the thing, remove it or pick it again. If Home Assistant does not answer, FamilyOS tries once more, then gives up; it never switches later.

## Who is home

FamilyOS can show beside each name on Today whether they are **Home**, **Away** or **At School**, from Home Assistant (its app or the router). Only what each person chooses to show about themselves. Nobody can choose for someone else, an admin included.

1. **An admin links people.** In **Settings → Family → Home Assistant**, **People** lists the family. Tap a member, choose who they are in Home Assistant (its **Settings → People**), then **Save**. **Unlink** in the same panel removes the link. Each row says what that person shares (**Shares nothing yet** at first).
2. **Each person chooses.** Under **Settings → You → Where I am**, a linked person picks:
   - **Nothing** (the start): nobody sees where they are.
   - **Home or away**: only whether they are home.
   - **Place**: the name of the Home Assistant zone they are in, like School or Work. Anywhere else reads **Away**. Zones are made in Home Assistant under **Settings → Areas, labels & zones**.

   Someone not linked sees: "Not linked to anyone in Home Assistant yet. Ask whoever set up Home Assistant."
3. **Displays are a choice of their own.** **Show on family displays** starts off. When on, a display allowed to see who is home (**Settings → Devices**) shows that person. When off, displays never show them.

**Good to know**
- **Who sees it**: roles with **See who is home** (every role at first; change under **Settings → Family → Roles**). It shows on Today beside each name, in every style, as the block **Who is home**, which anyone can hide under **What Today shows**.
- Read live, at most about a minute old. When Home Assistant cannot be reached, or does not know where someone is, nothing is shown.
- FamilyOS keeps only who is linked to whom and what each person chose. No history, no places or coordinates: the phone's position in Home Assistant's answer is thrown away before anything else is read. The map stays in Home Assistant.
- The assistant and connected AI apps ([MCP](mcp.md)) are never told where anyone is.

## Notifications on your phone

FamilyOS can send notifications to the Home Assistant app on a member's phone, through your Home Assistant with the same token. The app must be set up on that phone first.

1. **An admin picks the phone.** In **Settings → Family → Home Assistant**, tap a linked member in **People**. Under **Notifications**, Home Assistant's phones are listed; the one that looks like theirs is marked **Suggested**. Choose it, or **None**, then **Save**. Only linked members can have a phone.
2. **Send a test.** **Send a test** in the same panel sends a short text and shows the result: "Sent: check the phone", "This phone is no longer in Home Assistant" (choose another), "Home Assistant refused the token" or "Could not reach Home Assistant".
3. **Each member switches it on** under **Settings → Notifications**, kind by kind; it is off until then. Quiet hours and the other choices there apply. A member not linked yet sees **Home Assistant app** there with a note that an admin can link them.

The texts go to your Home Assistant and from there through its own push service to the phone, nowhere else. Home Assistant's address must be the **IP address** or an `https` address (not `homeassistant.local`).

## Not possible yet

- **Home Assistant's assistant (Assist)** reaches FamilyOS through [MCP](mcp.md#home-assistant); it acts as the person who set it up and can only read and suggest.
- The assistant cannot know who is home, nor switch anything.
- **A map**: FamilyOS shows a place's name, never a map.
- **Thermostats and alarm panels** can be shown but not switched (no setting a temperature, arming or disarming).
