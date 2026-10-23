# FamilyOS user guide

For whoever runs FamilyOS at home. Start with the first page; the others can wait until you need them.

1. [Install](install.md): Docker, first setup, adding the family.
2. [HTTPS and phones](https.md): reach FamilyOS from phones, install the app, share to it.
3. [Everyday use](everyday.md): Today, Quick add, the calendar, shopping and tasks.
4. [Family members, roles and devices](members.md): add people, choose what each may do, and set up phones and tablets.
5. [Backups](backups.md): what is backed up, copying backups away, restoring.
6. [AI and privacy](ai.md): choosing a provider, what the AI sees, turning things off.
7. [Notifications](notifications.md): reminders, suggestions to review, phone notifications, quiet hours.
8. [Telegram](telegram.md): share to Quick add and approve from Telegram.
9. [Email](email.md): school notices and other mail in Quick add, from a dedicated mailbox.
10. [Calendars](calendars.md): the calendar on your phone, school and Google calendars, reminders.
11. [Home Assistant](home-assistant.md): show the family calendar in Home Assistant, show sensors from Home Assistant on Today, and switch the things you choose.
12. [Family displays](displays.md): a wall tablet with today's plans, photos and weather.
13. [What needs doing and Papers](records.md): duties that come back, reminders, filing papers, archiving.
14. [Vehicles](vehicles.md): insurance and inspection dates, papers and a service log.
15. [Home](home.md): insurance, upkeep dates, things with warranties, and utilities.
16. [Pets](pets.md): vaccination and parasite dates, vet details, papers and a treatment history.
17. [Chores](chores.md): rotating household chores with one-tap done.
18. [The assistant](assistant.md): ask in plain language, suggestions to approve, what it remembers, what it sees, turning it off.
19. [Auto-approval](auto-approval.md): let routine suggestions, such as shopping items, be approved by themselves, safely and visibly.
20. [Bring your own agent (MCP)](mcp.md): connect your own AI agent, such as Hermes Agent or Claude Desktop, with a personal token; it reads what you may see and its changes are suggestions you approve.
21. [Kitchen](kitchen.md): recipes, a weekly meal plan and ingredients to the shopping list.
22. [The family board](board.md): short notes on paper for everyone, with a photo, an end day and a pin; on Today and on the family display.
23. [Using it offline](offline.md): shopping, tasks and chores keep working without a connection and are sent later.
24. [Search](search.md): find recipes, home things, events, duties and shared items by meaning, for you and for the assistant.
25. [Region and formats](region.md): date, time, number and week formats, separate from the language.
26. [Languages](languages.md): choose the language of the app and of each person, add or remove language packs, make your own.
27. [Appearance](appearance.md): choose a theme for the family, for yourself and for a display, add or remove themes, make your own.
28. [Extensions](extensions.md): install the kitchen, pets, vehicles or home, see what each reaches, switch one off or uninstall it.
29. [Connected apps](connected-apps.md): let Home Assistant or a script work with your calendar and lists with a key of its own, and decide what it may do.
30. [The API for apps and scripts](api.md): read and change the calendar, lists, chores and board from a program, with curl examples.
31. [Siri and Shortcuts](siri.md): say "Hey Siri, add to FamilyOS" to fill the shopping list, hear today's plans, or add a task, with Apple's Shortcuts app.
32. [Setup status](setup-status.md): see which of the things that make FamilyOS work well are set up, and what a missing one costs.
33. [Configuration](configuration.md): the environment variables the server reads, and backups from a terminal.

## Writing a guide page

A page is read by someone in the middle of setting something up. Help them find the step, the setting or the limit
they need, and stop.

- **Start with what it is for**, in one or two sentences. Send readers looking for something else to the right page in
  a short quote.
- **Steps are numbered** and name the exact place and words on screen (**Settings → Family → Extensions**). One action
  per step.
- **Use a table** when several things are compared on the same points: switches and their defaults, which apps work
  how, symptoms and fixes.
- **Collect the rest in "Good to know"**: one short line per fact (a limit, who may do it, when something stops).
- **Keep every concrete fact**: names of settings and buttons, numbers and limits, who may do what, what is kept or
  sent where, commands, and every warning about data or privacy. Shorten the sentence, not the fact.
- **Leave out** reasons why the software is built a certain way (they belong in
  [architecture.md](../architecture.md)), repeats of a warning that has its own page (link to it), and introductions
  or summaries of what the page is about to say or just said.
- **Say it once.** If two pages need the same explanation, one page explains it and the other links there.
- Write plain English for someone who is not a developer. Developer details go last, under **For developers**.
- Keep the headings that other pages link to (`page.md#heading`), or update those links in the same change.
