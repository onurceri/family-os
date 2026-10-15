# Extensions

Everything FamilyOS does comes from an **extension**: the calendar, the lists, Quick add, the kitchen and so on. A few are always there; the others come with FamilyOS but are installed only when your family wants them. Only admins manage extensions.

## What a new family has

- **Always there:** Calendar, Lists, Quick add, the assistant, the board, chores and records (the duties and papers that vehicles, pets and the home use). They cannot be uninstalled, but each can be switched off.
- **Installed for a new family:** Photos and weather, so Today shows the weather and the family's photos from the first day. Setup asks for your city right after you create your account; **Skip** leaves it for later.
- **Ready to install:** the kitchen, pets, vehicles and home.

A family that upgrades from a version before extensions could be installed keeps every extension it used.

## Installing one

**Settings → Family → Extensions** lists what is **Installed** and what is **Available**. Tap an available extension to see what it is for and **What it reaches**:

- **Stays inside FamilyOS**: it connects to nothing on the internet.
- **Connects to the internet**: the addresses it calls by itself (the weather calls Open-Meteo, for one).
- **Opens web addresses you give it**: only addresses someone in the family adds, such as a calendar link.
- **Can reach your home network**: only an address someone allows.
- **Adds permissions for roles**: who may see or change it; choose in **Roles**.
- **Needs**, **Installs … with it** and **Works with**: other extensions it needs (they install with it when they are not there yet) or uses when they are there.

Press **Install**. The extension starts working when FamilyOS restarts.

## Restarting

While something waits to be installed or uninstalled, the page says so and offers **Restart now**. FamilyOS finishes what it is doing, starts again and the page opens again by itself, usually within a few seconds. Nothing is lost.

Other phones and tablets notice it when they reconnect: family displays reload by themselves, and people see **FamilyOS changed** with **Reload**, so nothing they are typing is lost. FamilyOS restarts by itself only with the Docker setup from [Install](install.md) (or another one that starts it again when it stops); otherwise start it again by hand.

## Switching off and uninstalling

- **The switch** on an installed extension hides it and stops it for everyone at once, without a restart. Turn it back on and everything is as it was.
- **Uninstall** (in the **⋯** menu) removes it when FamilyOS restarts. **Its data is kept**: install it again and you find everything as it was. While it waits for the restart, **Keep it** in the same menu takes the uninstall back. An extension that another installed one needs cannot be uninstalled before that one.

## When an extension is left out

If an installed extension cannot run, FamilyOS starts without it and the page says so in its row: **Left out: it could not start**, or **Left out: this version cannot run on this FamilyOS**. **Details** in its **⋯** menu shows the reason the server gave. For one that could not start, **Try again** tries once more at the next restart. Its data is kept either way.

The same works from the server's command line, for example:

```bash
docker compose exec famos node /app/server/main.mjs extensions list
docker compose exec famos node /app/server/main.mjs extensions install pets
```

`extensions uninstall <id>` uninstalls one. A change made there loads at the next restart too.
