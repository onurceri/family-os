# Install

FamilyOS runs as one Docker container. A Raspberry Pi 4 is enough.

## Start it

```bash
mkdir familyos && cd familyos
curl -fsSLO https://raw.githubusercontent.com/onurceri/family-os/main/docker-compose.yml
docker compose up -d
docker compose logs famos
```

This downloads the compose file and the released FamilyOS image (for ordinary computers and for a Raspberry Pi). The folder holds only that file; the family's data lives in a Docker volume.

The log prints an address ending in `/setup?code=…`. Open it in a browser.

The compose file is the same for every version, so downloading it from `main` is fine. The version is chosen by `FAMOS_VERSION` (see Update).

### Port 3000 is taken

1. Create `docker-compose.override.yml` next to `docker-compose.yml`:

   ```yaml
   services:
     famos:
       ports: !override
         - "8080:3000"
   ```

2. Use `!override`. A plain `ports:` is merged with the original, and both ports are bound.
3. Run `docker compose up -d` and open `http://localhost:8080`.

### Phones and Home Assistant

1. Set `FAMOS_BASE_URL` in a `.env` file next to `docker-compose.yml` to the address those devices use, for example `http://192.168.1.20:3000`.
2. Restart with `docker compose up -d`. The setup link in the log uses this address.
3. Installing on phones needs https: see [HTTPS and phones](https.md).

1. Pick the language (**Choose your language**) and press **Continue**. It is preselected from your browser. It becomes the family's language, and everyone can choose their own later (see [Languages](languages.md)).
2. Optionally, enter a **Family name** the way you say it ("The Novaks"). Then enter your name, an email and a password (at least 10 characters). The setup code is already filled in.
3. Check **Time and region**. The time zone, the region format (date order, numbers, first day of the week), the 12- or 24-hour clock and Celsius or Fahrenheit are guessed from this browser. Correct them if they are wrong, for example on a laptop set up abroad or in a browser in another language: the time zone decides what "today" is and when reminders go off. Choosing another region format also picks its clock and temperature, which you can still change.
4. Tick **This device is shared at home (people with a PIN can sign in here)** if you are on the family tablet (see [Family members, roles and devices](members.md)).
5. Press **Create account**. That account is an **admin**.
6. Optionally, **Where do you live?**: search for your city to show the weather on Today and on displays, or press **Skip**; the same step can also be done later from Today's checklist. Choosing the first place turns the weather on. Only the name you search for is sent to Open-Meteo.com. You can change it later under **Settings → Family → Photos and weather**; changing the place later leaves the weather switch as it is. If you reload the page after creating the account, the step is not shown again.

You can change the time zone and the formats later under **Settings → Family → Language & region** (see [Region and formats](region.md)). **Settings** itself opens **Profile & sign-in** on a wide screen and **More** on a phone, for everyone.

The code makes sure that only you can set up a new instance, even if it is reachable from the internet before you get to it. It is also stored in the data volume as `setup-code`. To choose it yourself, set `FAMOS_SETUP_CODE` (at least 8 characters).

Everything lives in the `famos-data` volume (`/data` in the container):

| Path | What |
|---|---|
| `famos.db` | The database (SQLite) |
| `files/` | Shared photos and documents |
| `backups/` | Nightly backups |
| `languages/` | Language packs you installed |
| `secret` | Signs sessions and encrypts saved keys and passwords; see [Backups](backups.md) |
| `setup-code` | The setup code |

Settings that are not in the app are environment variables. The table is in the README.

## Add the family

Open **Settings → Family → Members** and add each person with a role. **Admin** can do everything, **Member** is for adults, **Supervised** is for children and anyone whose changes should be checked, **Guest** can only look. Who can do what, how people sign in and how to set up the kitchen tablet is on [Family members, roles and devices](members.md).

## Choose what FamilyOS does

A new family starts with the calendar, lists, Quick add, the assistant, the board, chores, records, and photos & weather. **Settings → Family → Extensions** installs the others (the kitchen, pets, vehicles, home) and switches any of them off for everyone. See [Extensions](extensions.md).

## Update

In the folder with `docker-compose.yml`:

```bash
docker compose pull && docker compose up -d
```

FamilyOS writes a backup before any update that changes the database, and keeps people signed in. To stay on a version instead of the newest one, set `FAMOS_VERSION` (for example `FAMOS_VERSION=0.1`, which still gets that version's fixes) in a `.env` file next to `docker-compose.yml`. What each version brings is on the [releases page](https://github.com/onurceri/family-os/releases).

### Building from source

To run your own changes, clone the repository and build the image there:

```bash
git clone https://github.com/onurceri/family-os && cd family-os
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

To update a source build: `git pull`, then the same command.
