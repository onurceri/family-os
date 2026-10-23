# Install

FamilyOS runs as one Docker container. A Raspberry Pi 4 is enough.

## Start it

1. Download the compose file and start FamilyOS:

   ```bash
   mkdir familyos && cd familyos
   curl -fsSLO https://raw.githubusercontent.com/onurceri/family-os/main/docker-compose.yml
   docker compose up -d
   docker compose logs famos
   ```

2. Open the address in the log that ends in `/setup?code=…`.

The image is the released one (computers and Raspberry Pi). The compose file is the same for every version; `FAMOS_VERSION` chooses the version (see Update). The family's data lives in a Docker volume, not the folder.

### Port 3000 is taken

1. Create `docker-compose.override.yml` next to `docker-compose.yml`:

   ```yaml
   services:
     famos:
       ports: !override
         - "8080:3000"
   ```

2. Use `!override`. A plain `ports:` is merged with the original, and both ports are bound.
3. Set `FAMOS_BASE_URL=http://localhost:8080` in a `.env` file next to `docker-compose.yml`, so links FamilyOS writes (the setup link too) use the new port.
4. Run `docker compose up -d` and open `http://localhost:8080`.

### Phones and Home Assistant

1. Set `FAMOS_BASE_URL` in a `.env` file next to `docker-compose.yml` to the address those devices use, for example `http://192.168.1.20:3000`.
2. Restart with `docker compose up -d`. The setup link in the log uses this address.
3. Installing on phones needs https: see [HTTPS and phones](https.md).

## Set up the account

1. Pick **Choose your language** (preselected from your browser) and press **Continue**. It becomes the family's language; everyone can choose their own later ([Languages](languages.md)).
2. Optionally, enter a **Family name** the way you say it ("The Novaks"). Then enter your name, an email and a password (at least 10 characters). The setup code is already filled in.
3. Check **Time and region**: time zone, region format (date order, numbers, first weekday), 12- or 24-hour clock, Celsius or Fahrenheit, all guessed from this browser. Correct them if wrong: the time zone decides what "today" is and when reminders go off. Another region format also picks its clock and temperature, which you can still change.
4. Tick **This device is shared at home (people with a PIN can sign in here)** if you are on the family tablet (see [Family members, roles and devices](members.md)).
5. Press **Create account**. That account is an **admin**.
6. Optionally, **Where do you live?**: search for your city to show the weather on Today and displays, or **Skip** (it is on Today's checklist later). Choosing the first place turns the weather on. Only the name you search for is sent to Open-Meteo.com. After a reload the step is not shown again.

### Good to know

- Change the time zone and formats later under **Settings → Family → Language & region** (see [Region and formats](region.md)), and the weather place under **Settings → Family → Photos and weather** (changing the place leaves the weather switch as it is).
- **Settings** opens **Profile & sign-in** on a wide screen and **More** on a phone, for everyone.
- The setup code stops anyone else setting up a new instance reachable from the internet. It is stored as `setup-code`; to choose it, set `FAMOS_SETUP_CODE` (at least 8 characters).
- Settings that are not in the app are environment variables. They are listed in [Configuration](configuration.md).

Everything lives in the `famos-data` volume (`/data` in the container):

| Path | What |
|---|---|
| `famos.db` | The database (SQLite) |
| `files/` | Shared photos and documents |
| `backups/` | Nightly backups |
| `languages/` | Language packs you installed |
| `secret` | Signs sessions and encrypts saved keys and passwords; see [Backups](backups.md) |
| `setup-code` | The setup code |

## Add the family

Open **Settings → Family → Members** and add each person with a role.

| Role | For |
|---|---|
| **Admin** | Can do everything |
| **Member** | Adults |
| **Supervised** | Children, and anyone whose changes should be checked |
| **Guest** | Can only look |

Who can do what, how people sign in and the kitchen tablet: [Family members, roles and devices](members.md).

## Choose what FamilyOS does

A new family starts with the calendar, lists, Quick add, the assistant, the board, chores, records, and photos & weather. **Settings → Family → Extensions** installs the others (kitchen, pets, vehicles, home) and switches any off for everyone. See [Extensions](extensions.md).

## Update

In the folder with `docker-compose.yml`:

```bash
docker compose pull && docker compose up -d
```

FamilyOS writes a backup before any update that changes the database, and keeps people signed in. To stay on a version, set `FAMOS_VERSION` (for example `FAMOS_VERSION=0.1`, which still gets that version's fixes) in a `.env` file next to `docker-compose.yml`. What each version brings is on the [releases page](https://github.com/onurceri/family-os/releases).

### Building from source

To run your own changes, clone the repository and build the image there:

```bash
git clone https://github.com/onurceri/family-os && cd family-os
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

To update a source build: `git pull`, then the same command.
