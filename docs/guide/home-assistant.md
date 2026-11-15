# Home Assistant

Show the FamilyOS calendar in [Home Assistant](https://www.home-assistant.io), and Home Assistant's sensors, switches and who is home in FamilyOS.

> For Home Assistant's AI using FamilyOS, see [Bring your own agent (MCP)](mcp.md#home-assistant).

## Show the calendar in Home Assistant

Read-only (change events in FamilyOS, see [Everyday use](everyday.md)). Works in its calendar panel, dashboards and automations. Nothing extra is installed in FamilyOS.

1. In FamilyOS: **Settings → You → Calendar on my phone**, choose **What to show**, press **Create address**, then **Copy address** ([Calendars](calendars.md#the-calendar-on-your-phone)). It is shown only once.
2. In Home Assistant: **Settings → Devices & services → Add integration → Remote Calendar**.
3. Name it, paste the address, finish.

**Good to know**
- Plain `http://` works on your home network; `webcal://` is accepted.
- Repeating, summer-time, all-day, multi-day, past-midnight events and places come through correctly.
- Home Assistant reads the address once a day, so a new event can take a day to show. To refresh every 15 minutes, add this automation (replace the entity with your calendar's **Entity ID**, under **Settings → Devices & services → Entities**):

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

- The address works like a password: anyone with it reads the calendar without signing in. Home Assistant keeps it in its settings and backups.
- If it leaks: **Remove** (twice) next to it under **Your addresses**, make a new one, put it into Home Assistant. The old one stops at once.

## Connect FamilyOS to Home Assistant

FamilyOS **never switches anything you did not allow**: a light, lock or cover is switched only after you turn that on for it, and only by allowed people. Home Assistant cannot limit a token, so FamilyOS keeps this by what it sends.

1. Install the extension: **Settings → Family → Extensions**, **⋯** → **Look for more**, download **Home Assistant**, install ([Extensions](extensions.md)); it works after a restart. Only admins can connect it, signed in with their password (a PIN cannot test or save the connection).
2. In Home Assistant, create a separate non-administrator user (say "FamilyOS") and sign in as it.
3. Open **Profile → Security → Long-lived access tokens**, press **Create token**, copy it. It is shown once.
4. In FamilyOS open **Settings → Family → Home Assistant**, press **Connect**:
   - **Address**: `http://192.168.1.20:8123` or `https://ha.example.net`. Use the **IP address**; `.local` names do not work. A trailing `/` or `/api` is removed.
   - **Token**: the one you copied.
5. Press **Test connection** (nothing saved). After a good test press **Save**; after a failed one fix it and **Test again**, or **Save anyway** (say, Home Assistant is off). Editing the address or token clears the result.

**Good to know**
- After saving, the page shows the address, Home Assistant's name and version, and the result.
- The token is sealed and never shown again; **Change** asks for it again.
- **Disconnect** (**⋯**) forgets the address and token; Home Assistant is unchanged. Delete an exposed token in Home Assistant too.

| Result | Meaning and fix |
|---|---|
| **Connected** | All is well. |
| **Token refused** | Create a new token, choose **Change**. |
| **Not Home Assistant** | Something else answers. Check address and port (usually 8123). |
| **Address not allowed** | FamilyOS refuses that address (special or link-local). Use Home Assistant's home-network address. |
| **Cannot be reached**, **No answer** | Is it running, is the address right? Use the IP, not `.local`. |
| **Check failed** | **Check again**, or **Change**. |

## Show sensors on Today and on the display

When the page says **Connected**, use **What to show**:

1. Press **Add**, search by name or id (`sensor.kitchen_temperature`) and choose it. If your home has too many things to list, type the id.
2. Give it a short name (up to 40 characters; it starts with Home Assistant's).
3. Press **Save**.

**Good to know**
- Up to 12 things. Tap a row to rename, reorder or remove. Disconnecting keeps the list.
- Sensors, doors, windows, lights, switches, locks, covers, thermostats, scenes and anything with a state. Lights and locks show state only; [switching](#switch-things-from-familyos) needs its own permission.
- **People, phones and places** are not offered: see [Who is home](#who-is-home).
- Everyone who may see Home Assistant values sees them on Today, in a section hideable in **What Today shows**.
- A family display shows them when allowed in **Settings → Devices**. Add the page **Around the house** under **Pages** in the screen's panel ([Family displays](displays.md#pages)) for a whole screen: two columns on a large one, with a count of those that do not fit.
- Values are live, at most about a minute old. When Home Assistant is unreachable nothing is shown (never an old value).
- Numbers keep Home Assistant's unit and your region's format.

| Kind | Reads |
|---|---|
| Doors, windows, covers, valves | **Open** / **Closed** |
| Locks | **Locked** / **Unlocked** |
| Motion | **Detected** / **Clear** |
| Smoke, problem | **Alert** / **OK** |
| Lights, switches, humidifiers | **On** / **Off** |
| Dimmable lights | **On · 60 %** |
| Humidifiers | **On · 45 %** (the target), with the mode if it is short: **On · 45 % · Sleep** |
| Covers and valves with a position | **Open · 40 %**, **Closed** |
| Fans with speeds | **Speed 2**, or the preset when one is active (**Auto**), **Off** |
| Thermostat | Mode and current temperature |
| Vacuum | **Cleaning**, **Docked**, **Going home**, **Paused**, **Idle**, **Error** |
| Media player | **Playing**, **Paused**, **Idle**, **On**, **Off**, **Standby**, **Loading** |
| Scene, button | **Last run 22:10** (with the date if another day), **Never run** |
| No value | **Not available** |

Anything else is worded as Home Assistant words it.

## Switch things from FamilyOS

Lights (and their brightness), switches, fans (on and off, the speed of a fan with a few, and its presets), humidifiers (on and off, target humidity and mode), on/off helpers (`input_boolean`), covers and water valves (and their position), locks, scenes, scripts, buttons, vacuums and media players (play, pause, power and volume), one by one:

1. In **Settings → Family → Home Assistant**, under **What to show**, tap the thing.
2. Turn on **Can be switched from FamilyOS** (off for everything at first). Until you allow it, a thing that can be switched says **Can be switched** on its row.
3. Optionally turn on **Ask before switching** (off for every item; FamilyOS does not guess). Use it for locks, garage doors and water valves: FamilyOS then asks first, e.g. "Unlock Front door?". Earlier items keep their choice.
4. Press **Save**.

The row on Today and on this page then has a switch (lights, switches, fans, humidifiers), **Open** / **Close** (covers; **Stop** while moving), **Lock** / **Unlock**, **Run** (scenes, scripts), **Press** (buttons), **Open** / **Close** (valves; **Stop** while moving), **Start** / **Pause** / **Send home** (vacuums), or **Play** / **Pause** / **Turn on** / **Turn off** (media players, by what they are doing now). The value says **Switching…** until the new state shows, usually in seconds.

**Good to know**
- Needs the role permission **Switch things through Home Assistant**: admins at first; give it under **Settings → Family → Roles**. Others see values, no switches.
- Family displays, the assistant and connected AI apps ([MCP](mcp.md)) never switch anything and cannot suggest it.
- The token can do more than FamilyOS allows: Home Assistant has no partial tokens, so it can switch and unlock everything its user can. Keep it safe and the user non-administrator.
- **Switched lately** (same page) lists the last 10: "Tom turned on Living room light", "Mara ran Movie night", "Tom unlocked Front door"; failures read "Could not switch Living room light" with who asked. Entries keep the name the thing had then, survive rename and removal, are kept about 3 months and are visible to everyone who can open the page. A display not allowed names says "Someone". A switchable thing also shows its own last 5.
- On failure the person sees "Could not switch …". **Token refused**: new token, **Change**. Thing gone from Home Assistant: remove or re-pick it. No answer: FamilyOS retries once, then gives up; it never switches later.

## Who is home

Today can show beside each name **Home**, **Away** or **At School**, from Home Assistant (its app or router). Only what each person chooses to share; nobody, admins included, can choose for another.

1. **Admin links people.** **Settings → Family → Home Assistant → People**: tap a member, choose who they are in Home Assistant (its **Settings → People**), **Save**. **Unlink** removes it. Each row shows what they share (**Shares nothing yet** at first).
2. **Each person chooses** under **Settings → You → Where I am**:
   - **Nothing** (start): nobody sees.
   - **Home or away**.
   - **Place**: the Home Assistant zone name (School, Work), else **Away**. Zones: Home Assistant **Settings → Areas, labels & zones**.

   Unlinked people see "Not linked to anyone in Home Assistant yet. Ask whoever set up Home Assistant."
3. **Displays**: **Show on family displays** starts off. When on, a display allowed to see who is home (**Settings → Devices**) shows them; when off, never.

**Good to know**
- Needs the role permission **See who is home** (every role at first; **Settings → Family → Roles**). Shown on Today in every style as the block **Who is home**, hideable under **What Today shows**.
- Live, at most about a minute old; nothing when Home Assistant is unreachable or does not know.
- FamilyOS keeps only who is linked to whom and each choice: no history, no places, no coordinates (discarded before anything else is read). The map stays in Home Assistant.
- The assistant and connected AI apps ([MCP](mcp.md)) are never told where anyone is.

## Notifications on your phone

FamilyOS can send notifications to the Home Assistant app on a member's phone, via your Home Assistant with the same token. The app must be set up on the phone first.

1. **Admin picks the phone.** **Settings → Family → Home Assistant → People**, tap a linked member. Under **Notifications**, choose a phone (the likely one is marked **Suggested**) or **None**, **Save**. Only linked members.
2. **Send a test** (same panel). Results: "Sent: check the phone", "This phone is no longer in Home Assistant" (choose another), "Home Assistant refused the token", "Could not reach Home Assistant".
3. **Each member turns it on** kind by kind under **Settings → Notifications** (off until then). Quiet hours and the other choices apply. Unlinked members see **Home Assistant app** there with a note that an admin can link them.

Texts go only to your Home Assistant, then through its push service to the phone. Its address must be the **IP address** or an `https` address.

### Levels, positions and modes

A thing that can be set to more than on or off has a sheet. Its row says the state under the name (**On · 60 % ›**), keeps its own control at the end (the switch, or Open, Close, Stop, Play, Pause), and opens the sheet when you tap the name on Today. The sheet is a small form of labelled groups. What it shows comes from what Home Assistant reports for that thing right now:

| Thing | Sheet |
|---|---|
| Light that dims | **Power**, **Brightness** (1 to 100 %) |
| Cover, valve with a position | **Position** (0 to 100 %, **Closed** to **Open**) |
| Humidifier | **Power**, **Target humidity** (between the lowest and highest it reports), **Mode** |
| Media player with a volume | **Volume** (0 to 100 %); Play and Pause stay on the row |
| Fan | **Power**, **Speed** (two to six speeds, one tile each: **1 2 3 4**), **Preset** |

A number is a slider with **−** and **+** at the ends and its value beside them (**60 %**). Moving the slider sends nothing until you let go; **−** and **+** send after a short pause, so five taps are one change. A mode or a preset is a tile for each word Home Assistant lists (up to six, otherwise a list); the common words (Auto, Sleep, Normal, Eco …) are translated, any other is shown as Home Assistant words it. Choosing is sent at once, the row says **Switching…** until the thing answers (and the value goes back if it could not be done), and **Done** closes the sheet.

With **Ask before switching** the sheet has **Cancel** and **Set**: the switch, the sliders and the tiles only choose, nothing changes until you tap **Set**, and then each thing you changed is sent. Choosing a brightness or a speed on something that is off turns it on. People who may not switch things, and displays, see the values but nothing to tap. A thing that reports nothing to set (a light that is only on or off, a fan without speeds) has just its control.

**Switched lately** says "Tom set Kitchen light to 60 %", "Tom set Bedroom humidifier to Sleep" or "Tom set the volume of TV to 30 %".

FamilyOS sends only these settings with a switch, one at a time and only what Home Assistant says the thing allows: a brightness of 1 to 100, a position of 0 to 100, a humidity inside the thing's own limits, a volume of 0 to 100, and a mode or preset the thing lists. Anything else is refused, and nothing is sent.

## Not possible yet

- Home Assistant's Assist reaches FamilyOS through [MCP](mcp.md#home-assistant), as the person who set it up, read and suggest only.
- The assistant cannot know who is home or switch anything.
- No map, only a place's name.
- Thermostats and alarm panels can be shown, not switched (no temperature setting, arming, disarming).
- Fans have no oscillation or direction, only speeds and presets.
- Lights have no colour or colour temperature, only brightness.
- Media players have no source or track, and covers no tilt.
- Setting a number or choosing from a list in Home Assistant beyond the ones above is not possible.
