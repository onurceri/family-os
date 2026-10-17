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

This is the other direction: FamilyOS looks at your Home Assistant. For now it only connects and checks that the connection works. Showing sensors and who is home comes next.

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

## Not possible yet

- **Home Assistant's assistant (Assist)** cannot connect to FamilyOS's AI door ([MCP](mcp.md)) yet, because Home Assistant connects only with a sign-in method that FamilyOS does not offer. Other AI apps work today; see [Bring your own agent (MCP)](mcp.md).
- **Showing Home Assistant's sensors, and who is home, on Today and on the family display** comes next. The connection above already exists; what to show is not chosen yet.
