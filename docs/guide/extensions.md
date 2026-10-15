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

## Installing one from a file

An extension can also come as a file ending in `.famext`, for example a newer version of one you have. In **⋯** at the top of the Extensions page, choose **Add from a file** and pick the file. FamilyOS checks it first and nothing is installed yet: the details open with what it reaches, what installs with it and **Who made it**. When it is a newer version of an extension you already have, the details say **Updates version 1.0.0 to 1.1.0** and the button is **Update**. Press **Install** (or **Update**); it starts working when FamilyOS restarts, and until then the row says **Updates to 1.1.0 when FamilyOS restarts**.

FamilyOS installs a file only when it is **signed by FamilyOS**: the signature proves where it comes from and that nobody changed it since. It checks this again every time it starts, and leaves an extension out if its files were changed. A file it refuses says why:

- **FamilyOS cannot confirm who made this file**: it is not signed by FamilyOS, or it was signed by someone else.
- **This file is too large**: an extension file can be at most 20 MB.
- **This extension is made for another version of FamilyOS**: update FamilyOS, or find the file made for yours.
- **This file holds an older version**: FamilyOS already has a newer one.
- **This is not an extension file FamilyOS can read**: the file is damaged or was changed.

A newer FamilyOS that brings a newer version of the extension uses that one. Extensions installed from a file are part of your [backups](backups.md).

## Looking for more online

FamilyOS publishes its extensions, and newer versions of them, in an index on the internet. FamilyOS looks there **only when you ask**: never by itself, in the background or when it starts.

In **⋯** at the top of the Extensions page, choose **Look for more**. FamilyOS fetches the index and checks that FamilyOS signed it. **Found online** then lists what your FamilyOS does not have yet: extensions that did not come with it, and newer versions of the ones you have (**Version 1.1.0 is out**). An extension that came with FamilyOS but is not installed is listed once, under Found online, when the index has a newer version of it.

Tap one to see what it is for, its version and how much it downloads, then press **Download**. FamilyOS downloads it, checks that it is exactly the file the index describes, and checks it like a file: the details then show what it reaches and **Who made it**, with **Install** (or **Update**). It starts working when FamilyOS restarts.

When looking does not work, the page says why: the index could not be reached (check that the server is online), it was **not signed by FamilyOS** (nothing in it is offered), or it is not one your version can read (updating FamilyOS helps). A download that does not match the index is not used; try again.

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

`extensions install /data/<file>.famext` installs one from a file (copy it into the volume first with `docker compose cp`), and `extensions uninstall <id>` uninstalls one. A change made there loads at the next restart too.

## Removing an extension's data for good

Uninstalling keeps an extension's data, so nothing is lost when you change your mind. When you are sure you will not need it again, its data can be removed for good, from the server's command line only (the app never offers it):

```bash
docker compose exec famos node /app/server/main.mjs extensions uninstall pets
docker compose restart famos
docker compose exec famos node /app/server/main.mjs extensions purge pets
```

FamilyOS first says what it will remove and asks you to type the extension's name; `--yes` skips the question (for scripts). It then writes a [backup](backups.md) and stops if the backup fails. After that it removes everything the extension stored: its tables, its files, its waiting jobs, drafts and notifications, and what FamilyOS kept about it (who may use it in **Roles**, what displays may show of it, its switch, its **AI** area, notification choices and what Today hides of it). It ends with a list of what it removed. The audit log and the AI usage it counted stay.

It refuses an extension that is still installed (uninstall it first), one FamilyOS still uses because it has not restarted since it was uninstalled (restart FamilyOS first), one that is always there, and one that never ran on this server. Installed again later, the extension starts empty, as if it were new. To get the data back, restore the backup written before it was removed.
