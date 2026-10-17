# Home Assistant

If your family uses [Home Assistant](https://www.home-assistant.io), you can show the FamilyOS calendar there: in its calendar panel, on its dashboards, and in automations, such as "turn the porch light on when someone has an evening event". It is read-only: you change events in FamilyOS (see [Everyday use](everyday.md)), and Home Assistant follows.

You need nothing extra installed in FamilyOS. It uses the same calendar address as the calendar on your phone.

## Show the calendar in Home Assistant

1. **In FamilyOS,** create a calendar address as described in [Calendars](calendars.md#the-calendar-on-your-phone): **Settings → You → Calendar on my phone**, choose **What to show**, and press **Create address**. Copy it with **Copy address**. It is shown only once.
2. **In Home Assistant,** open **Settings → Devices & services → Add integration** and choose **Remote Calendar**.
3. Give the calendar a name, paste the address, and finish. The FamilyOS events appear in Home Assistant's calendar. A plain `http://` address works on your home network, and a `webcal://` address is accepted too.

Repeating events, the change to and from summer time, all-day and multi-day events, events that run past midnight, and the place of an event all come through correctly.

## Keep it up to date

Home Assistant reads the address only once a day, so a new event can take up to a day to show. To keep it current, add an automation that asks Home Assistant to read it again, for example every 15 minutes. You can build it in the automation editor, or paste this in YAML:

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

Replace `calendar.your_calendar_name` with your calendar's own name. You find it under **Settings → Devices & services → Entities**: search for the name you gave the calendar and copy its **Entity ID**.

## Keep it safe

The address works like a password: anyone who has it can read the calendar, without signing in. Home Assistant keeps it in its settings, and so in its backups, so look after those too. If it gets out, press **Remove** (twice) next to it under **Your addresses** in FamilyOS, make a new one, and put the new one into Home Assistant. The old address stops working at once.

## Connect FamilyOS to Home Assistant

This is the other direction: FamilyOS looks at your Home Assistant. You choose a few things to show on Today and on the family display, and each person can choose to show whether they are home (see [Who is home](#who-is-home)).

FamilyOS **only reads** from Home Assistant. It never switches a light, a lock or anything else, and it never asks Home Assistant to do anything. Home Assistant cannot limit what a token may do, so this is a promise FamilyOS keeps by what it sends, not something Home Assistant enforces.

1. **Install the extension.** It is not part of FamilyOS itself: in **Settings → Family → Extensions**, choose **Look for more** in the **⋯** menu, download **Home Assistant** and install it (see [Extensions](extensions.md)). It starts working when FamilyOS restarts. Only admins can connect it.
2. **Make a user for FamilyOS in Home Assistant.** Create a separate user, for example "FamilyOS", and do not make it an administrator. Sign in as that user.
3. **Create a token.** Open that user's **Profile → Security**, scroll to **Long-lived access tokens**, press **Create token** and copy it. Home Assistant shows it only once.
4. **Connect.** In FamilyOS open **Settings → Family → Home Assistant**, press **Connect**, and fill in:
   - **Address**: where Home Assistant is, for example `http://192.168.1.20:8123` or `https://ha.example.net`. Use the **IP address**: names ending in `.local` do not work from FamilyOS. Leave off a trailing `/` or `/api`; FamilyOS removes them.
   - **Token**: the one you just copied.

FamilyOS then checks the connection and the page shows the address, your Home Assistant's name and version, and the result. The token is kept sealed and is never shown again, so **Change** asks for it again. **Disconnect** (in the **⋯** menu) makes FamilyOS forget the address and the token; nothing changes in Home Assistant. If a token was ever exposed, delete it in Home Assistant too.

What the result means:

- **Connected**: all is well.
- **Token refused**: Home Assistant did not accept the token. Create a new one and choose **Change**.
- **Not Home Assistant**: something answers at that address, but not Home Assistant. Check the address and the port (Home Assistant usually uses 8123).
- **Address not allowed**: FamilyOS does not connect to that address, for example a special or link-local one. Use Home Assistant's address on your home network.
- **Cannot be reached** or **No answer**: is Home Assistant running, and is the address right? A name ending in `.local` never works; use the IP address.
- **Check failed**: something else went wrong. Choose **Check again**, or **Change** to enter the details again.

## Show sensors on Today and on the display

Once the connection says **Connected**, the same page has a **What to show** section. Pick the few things you want the family to see, for example the temperature outside, whether the front door is open, or what the washing machine is doing.

1. Press **Add**. Search by name or by id (such as `sensor.kitchen_temperature`) and choose it.
2. Give it a short name of your own, up to 40 characters. It starts with Home Assistant's name for it.
3. Press **Save**.

You can show up to 12 things. Tap a row to rename it, move it up or down, or remove it. Disconnecting keeps the list, so connecting to the same Home Assistant again finds it as it was.

You can show sensors, doors and windows, lights, switches, locks, covers, thermostats and anything else Home Assistant reports a state for. FamilyOS only reads the state: it never switches a light or opens a lock, and showing one does not let anyone else do it. **People, their phones and places** are not offered here: where someone is has its own choice, made by each person (see [Who is home](#who-is-home)). If your home has so many things that FamilyOS cannot list them, type the entity's id instead, for example `sensor.kitchen_temperature`.

Everyone who may see Home Assistant values finds them on Today, in a small section that can be hidden in **What Today shows**. A family display shows them too, when you have allowed it to see Home Assistant values in **Settings → Devices**. Values are read live and are about a minute old at most. When Home Assistant cannot be reached, nothing is shown rather than an old value, and Today says nothing about it.

Numbers keep the unit Home Assistant uses and follow your region's format. Doors, windows and covers read **Open** or **Closed**, locks **Locked** or **Unlocked**, motion **Detected** or **Clear**, smoke or a problem **Alert** or **OK**, lights and switches **On** or **Off**, and a thermostat its mode and the current temperature. Anything else is shown the way Home Assistant words it. A thing with no value reads **Not available**.

## Who is home

Home Assistant knows where the people of the house are, from their phones (its app) or from the router. FamilyOS can show beside each name on Today whether they are **Home**, **Away**, or **At School**, but only what each person chooses to show about themselves. Nobody can choose it for someone else, an admin included.

1. **An admin links people.** In **Settings → Family → Home Assistant**, the **People** section lists the family. Tap a member and choose who they are in Home Assistant (the people Home Assistant has under its **Settings → People**), then **Save**. **Unlink** in the same panel takes the link away. Linking shows nothing yet: each row says what that person shares (**Shares nothing yet** at first), and only they can change it.
2. **Each person chooses.** Under **Settings → You → Home Assistant**, a linked person picks what FamilyOS shows about them:
   - **Nothing** (the start): nobody sees where they are.
   - **Home or away**: only whether they are at home.
   - **Place**: the name of the Home Assistant zone they are in, like School or Work, as Home Assistant names it. Anywhere else reads **Away**. Zones are made in Home Assistant under **Settings → Areas, labels & zones**.

   Someone who is not linked sees "You are not linked to a Home Assistant person" there.
3. **Displays are a choice of their own.** With **Show on family displays** on (it starts off), a family display that was allowed to see who is home (**Settings → Devices**) shows it too. With it off, displays never show that person, whatever the display may see.

**Who sees it**: people whose role has **See who is home** (every role has it at first; change it under **Settings → Family → Roles**). They see it on Today, beside each name, in every style. It is a block of its own, **Who is home**, which anyone can hide under **What Today shows**. It is read live and is about a minute old at most; when Home Assistant cannot be reached, nothing is shown rather than an old place. Someone whose whereabouts Home Assistant does not know shows nothing.

**What FamilyOS keeps**: only who is linked to whom and what each person chose. It keeps no history of where anyone was and never stores a place or coordinates: Home Assistant's answer holds the phone's position, and FamilyOS throws it away before it reads anything else. The map stays in Home Assistant.

**The assistant does not see it.** FamilyOS's assistant and AI apps connected to FamilyOS ([MCP](mcp.md)) are never told where anyone is.

## Not possible yet

- **Home Assistant's assistant (Assist)** cannot connect to FamilyOS's AI door ([MCP](mcp.md)) yet, because Home Assistant connects only with a sign-in method that FamilyOS does not offer. Other AI apps work today; see [Bring your own agent (MCP)](mcp.md).
- **The assistant cannot know who is home**, not even for people who show it on Today.
- **A map**: FamilyOS shows a place's name, never a map.
