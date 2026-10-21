# Backups

FamilyOS writes a backup every night (at 03:00 by default, `FAMOS_BACKUP_HOUR`) and keeps the last 7 nightly ones (`FAMOS_BACKUP_KEEP`). It also writes one before every change to the data, such as an update or installing an extension (the last 3 of those are kept, apart from the nightly ones, so they never take their places). Backups you start yourself are never deleted automatically.

The hour is the server's local time. In the container that is UTC unless you set `TZ` in `docker-compose.yml`.

A backup is a single `.tar` file in `/data/backups` with the database, all shared files, installed language and theme packs, extensions installed from a file and a checksum. Backups on the server itself are not encrypted; they sit next to the database they came from.

## Send copies somewhere else

A backup on the same disk does not survive a broken disk or a stolen server. Under **Settings → System → Backups** (admins) you can have every nightly backup sent to another place:

1. **Lock the copies first.** Tap the row under **Locking the copies**; a panel, **Lock the copies**, walks you through it in steps. Nothing leaves the server until you choose.
   - **Why lock the copies.** Before a copy leaves the server, FamilyOS locks it (this is called encryption, done with [age](https://age-encryption.org)). Only someone with the passphrase can open it: not the storage company, and not anyone who finds the file. Backups kept on the server itself stay as they are.
   - **Choose a passphrase.** A passphrase is a long password made of a few words; you will be asked for it when a backup is brought back, maybe years from now. At least 12 characters; you type it twice and tick **I have written the passphrase down**, then **Save passphrase**. The server keeps it (locked with the server's key file, see below) so that nightly backups run unattended. **Without this passphrase nobody can open the copies.** Write it down and keep it away from this server.
   - **Done.** The last step lists what you need to bring a backup back: a backup, the passphrase, and the server's key file.

   **Other ways** in the first step offers the rest:
   - **Public key** (for people who already use the age tool). Create a key pair on your own computer with `age-keygen`, and paste only the public key (`age1…`), then **Save public key**. The server then holds no secret for your backups at all; you need the private key to restore.
   - **Send without a lock.** Possible, but anyone who can read the storage can read your family's data. Only choose it for storage you fully control.
2. **Add a copy.** Press **Add a copy** and pick the kind:
   - **S3 storage** (Amazon S3, Backblaze B2, Wasabi, MinIO, Cloudflare R2): **Server address**, **Region**, **Bucket**, an optional **Folder in the bucket**, **Access key ID** and **Secret access key**. Switch on **Address the bucket by path** for MinIO and R2. Big backups are uploaded in parts.
   - **WebDAV:** the **Folder address** (for Nextcloud `https://cloud.example/remote.php/dav/files/<user>/FamilyOS`), your **User name** and an **App password** (Nextcloud: Settings, Security). Use the exact address the server answers on; redirects are not followed.
3. Press **Add**. Tap the copy to open it and press **Test connection**, then press **Back up now** at the top of the page. Each copy shows when it last received a copy, or why it did not. A failed upload is retried up to 5 times over about 6 hours. If the cause cannot get better by waiting (wrong password, no lock chosen), or the retries run out, admins get a notification.

Under **Keep the last** each target keeps the last N copies (7 by default) and deletes older FamilyOS backups from that folder (never other files). Removing a target leaves the files it already received. To pause a target, switch off **Send backups here**.

### The server's key file

FamilyOS keeps a few passwords and keys for you (AI keys, the Telegram bot token, the mailbox password, the backup passphrase, calendar subscription addresses), locked with **the server's key file**: the file `secret` in the data folder, or `FAMOS_SECRET` if whoever installed FamilyOS set it. Backups leave this file out on purpose, so a stolen backup cannot open them. So keep a copy of it somewhere safe as well, away from the server:

```bash
docker compose cp famos:/data/secret ./familyos-secret
```

Without it, a restore still brings back all data, but everyone must sign in again, and everything locked with the key file stops working until you enter it again: AI keys, the Telegram bot token, the mailbox password, backup passwords and the passphrase, and calendar subscription addresses. Phone notifications stop working as well.

## Write a backup now

In the app: **Settings → System → Backups → Back up now** (it also sends the copy to your targets). The list under **On this server** shows the newest ones and whether each was **Nightly**, **Manual** or **Before a change to the data**. From a terminal:

```bash
docker compose exec famos node /app/server/main.mjs backup
```

The running server sends that copy to your targets.

## Restore

```bash
docker compose stop famos
docker compose run --rm famos restore /data/backups/<file>.tar
docker compose start famos
```

To restore a copy from elsewhere, put it into the volume first (`docker compose cp ./file.tar famos:/data/backups/`). Restoring never deletes the current data: it is moved aside as `famos.db.pre-restore-<time>`, `files.pre-restore-<time>` and, if the backup holds language or theme packs or extensions installed from a file, `languages.pre-restore-<time>`, `themes.pre-restore-<time>` and `extensions.pre-restore-<time>`. A backup from a newer FamilyOS is refused.

### After a restore: everyone signs in again
A backup is a picture of an earlier day, and the restore must not undo what the family ended since. So the first time the server starts after a restore:

- Everyone is signed out and signs in again, on every phone, tablet and computer.
- What was **ended after the backup stays ended**, as long as the replaced data is still next to the new one (`famos.db.pre-restore-<time>`): app keys that were revoked, devices and displays that were removed, members who were removed, calendar addresses that were stopped, and Telegram chats that were unlinked. A password or PIN changed after the backup stays changed, so a password changed after a leak does not come back.
- **Access taken away stays taken away.** For each person's role, for whether a person is archived, and for what each role may do, the narrower of the backup and the day before the restore is kept. So a person you demoted, a person you archived and a role you narrowed after the backup stay that way, while a promotion or a widening made after the backup is lost, like the rest of that day. If this would leave nobody able to manage settings, the people who were admins before the restore keep that access too. Admins are told how many people kept the access they have now.
- **Connected apps are paused**, even on a new server: a backup can hold the key of an app that was revoked, replaced or leaked since. Admins look at them in **Settings → Connected apps** and press **Resume** on the ones they trust.
- Nothing is ever switched back on by this. Keys, devices, addresses and links made after the backup are gone, as the rest of that day is, and a person must make them again.
- On a new server, where nothing was set aside, nothing was ended since, so only the sign-out happens.

Admins get a notification that says what stayed ended. If you delete the `*.pre-restore-*` files before the first start, only the sign-out happens.

Extensions installed from a file come back with the backup, and FamilyOS checks their signature again when it starts. A backup from an older FamilyOS that does not hold them still restores: an extension it says is installed but that this server has no package of is left out (Settings lists it with the reason), and everything else starts as usual. Install that extension again to bring it back; its data was kept.

### Restoring an encrypted backup

Encrypted copies are named `famos-<time>-<reason>.tar.age`. FamilyOS restores them directly. It asks for the passphrase, or reads it from `FAMOS_BACKUP_PASSPHRASE`:

```bash
docker compose run --rm -e FAMOS_BACKUP_PASSPHRASE='your passphrase' famos restore /data/backups/<file>.tar.age
```

For a backup encrypted to a public key, give the private key file made by `age-keygen`:

```bash
docker compose run --rm -v ./key.txt:/key.txt famos restore /data/backups/<file>.tar.age --identity /key.txt
```

The file is a standard age file, so you can also decrypt it on any computer with the `age` tool and then restore the `.tar` as above:

```bash
age -d -o backup.tar backup.tar.age          # asks for the passphrase
age -d -i key.txt -o backup.tar backup.tar.age   # with a private key
```

On **new hardware** you need three things: the backup, the passphrase (or private key), and the server's key file (`secret`, or your `FAMOS_SECRET`).
