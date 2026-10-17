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

## Not possible yet

- **Home Assistant's assistant (Assist)** cannot connect to FamilyOS's AI door ([MCP](mcp.md)) yet, because Home Assistant connects only with a sign-in method that FamilyOS does not offer. Other AI apps work today; see [Bring your own agent (MCP)](mcp.md).
- **Showing Home Assistant's sensors, and who is home, on Today and on the family display** is planned as an extension.
