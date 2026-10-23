# Extensions

Every FamilyOS feature is an **extension**. Only admins manage them, in **Settings → Family → Extensions**; changes load at restart.

| Group | Extensions |
|---|---|
| Always there (cannot be uninstalled, can be switched off) | Calendar, Lists, Quick add, the assistant, the board, chores, records (duties and papers for vehicles, pets and the home) |
| Installed for a new family | Photos and weather. Setup asks for your city after you create your account; **Skip** leaves it for later. |
| Ready to install | Kitchen, pets, vehicles, home |
| Found online | Home Assistant ([Home Assistant](home-assistant.md)); download it with **Look for more** |

A family upgrading from before extensions were installable keeps every extension it used.

## Install one

1. In **Extensions**, **Available** is listed above **Installed** (below it once everything bundled is installed).
2. Tap one for its purpose and **What it reaches**:
   - **Stays inside FamilyOS**: connects to nothing on the internet.
   - **Connects to the internet**: lists the addresses it calls (weather: Open-Meteo).
   - **Opens web addresses you give it**: only ones the family adds, like a calendar link.
   - **Can reach your home network**: only an address someone allows.
   - **Adds permissions for roles**: choose who in **Roles**.
   - **Needs**, **Installs … with it**, **Works with**: other extensions it needs (installed with it) or uses.
3. Press **Install**.

## Install from a file

For a `.famext` file, such as a newer version of one you have:

1. **⋯** at the top → **Add from a file**, pick the file. Nothing installs yet: the details show what it reaches, what installs with it and **Who made it**.
2. A newer version says **Updates version 1.0.0 to 1.1.0** and the button is **Update**. Press **Install** (or **Update**). Until restart the row says **Updates to 1.1.0 when FamilyOS restarts**.

**Good to know**
- Only files **signed by FamilyOS** install. The signature is rechecked at every start; a changed extension is left out.
- A newer FamilyOS with a newer version uses that one.
- File-installed extensions are in your [backups](backups.md).

| If it says | Meaning |
|---|---|
| **FamilyOS cannot confirm who made this file** | Not signed by FamilyOS, or signed by someone else. |
| **This file is too large** | Maximum 20 MB. |
| **This extension is made for another version of FamilyOS** | Update FamilyOS, or find the file made for yours. |
| **This file holds an older version** | FamilyOS already has a newer one. |
| **This is not an extension file FamilyOS can read** | Damaged or changed. |

## Look for more online

1. **⋯** → **Look for more**. FamilyOS fetches its signed index **only when you ask**, never in the background or at start.
2. **Found online** lists what you lack: extensions not bundled, and newer versions (**Version 1.1.0 is out**). A bundled, uninstalled extension appears only with a newer version. It shows **Last looked 19 Oct 2026, 03:35** and **Look again**.
3. Tap one for purpose, version and download size, press **Download** (checked against the index), then **Install** (or **Update**) after reading what it reaches and **Who made it**.

| If it says | Meaning |
|---|---|
| **has not published its list of extensions yet** | Nothing to download. What comes with FamilyOS is under Available and installs without the internet. |
| Index could not be reached | Check this server's internet connection. |
| **not signed by FamilyOS** | Nothing in it is offered. |
| Not one your version can read | Update FamilyOS. |
| A download does not match the index | It is not used. Try again. |

## Restart

Pending changes show on the row to every admin ("Mara asked to uninstall at … · waiting for a restart"). **Restart now** lists what changes and who asked, then restarts; the page reopens by itself, usually in seconds. Nothing is lost.

**Good to know**
- Family displays reload by themselves. People see **FamilyOS changed** with **Reload**, so nothing they type is lost.
- FamilyOS restarts by itself only with the Docker setup from [Install](install.md) (or another that restarts it); otherwise start it by hand.

## Switch off and uninstall

- **The switch** hides and stops it for everyone at once, no restart (the name only opens details). The message says **Lists is off for everyone** with **Undo**; its pages say **Lists is switched off for the family** and who can switch it on. Switched back on, all is as it was.
- **Uninstall** (**⋯**) removes it from everyone's menu at restart; its pages say the extension is not installed (admins get the way to Extensions).
- Data is kept, and so is the extension: it is listed under **Available** and reinstalls without internet, all as it was.
- **Keep it** on the row (or **Undo** in the notice) takes back a waiting uninstall; **Cancel install** takes back a waiting install.
- An extension another installed one needs cannot be uninstalled before that one.

## When an extension is left out

An extension that cannot run is skipped; its row says **Left out: it could not start** or **Left out: this version cannot run on this FamilyOS**. Data is kept.

- **Details** in its **⋯** menu shows the server's reason.
- **Try again** (could not start) retries at the next restart.

## For developers

The server's command line does the same; changes load at the next restart:

```bash
docker compose exec famos node /app/server/main.mjs extensions list
docker compose exec famos node /app/server/main.mjs extensions install pets
```

`extensions install /data/<file>.famext` installs from a file (copy it into the volume first with `docker compose cp`); `extensions uninstall <id>` uninstalls.

### Remove an extension's data for good

Command line only (the app never offers it); uninstalling alone keeps data:

```bash
docker compose exec famos node /app/server/main.mjs extensions uninstall pets
docker compose restart famos
docker compose exec famos node /app/server/main.mjs extensions purge pets
```

- It says what it will remove and asks you to type the extension's name; `--yes` skips the question.
- It writes a [backup](backups.md) first and stops if that fails.
- It removes the extension's tables, files, waiting jobs, drafts and notifications, and what FamilyOS kept about it: **Roles** permissions, what displays may show, its switch, its **AI** area, notification choices and what Today hides. It ends with a list of what it removed. The audit log and counted AI usage stay.
- It refuses an extension still installed, one not yet restarted since uninstall, one that is always there, and one that never ran on this server.
- Installed again later, it starts empty. To get the data back, restore the backup written before removal.
