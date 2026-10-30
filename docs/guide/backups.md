# Backups

A nightly backup, copies sent elsewhere, a download, and how to restore.

**Good to know**
- Nightly at 03:00 by default (`FAMOS_BACKUP_HOUR`, server local time; in the container UTC unless you set `TZ` in `docker-compose.yml`). The last 7 are kept (`FAMOS_BACKUP_KEEP`).
- One more is written before every change to the data (update, installing an extension). The last 3 of these are kept apart from the nightly ones.
- Backups you start yourself are never deleted automatically.
- A backup is one `.tar` in `/data/backups`: database, shared files, installed language and theme packs, extensions installed from a file, checksum.
- Backups on the server are not encrypted.

## Send copies somewhere else

A backup on the same disk does not survive a broken disk or a stolen server. Admins send nightly backups elsewhere under **Settings → System → Backups**.

1. Lock the copies first: tap the row under **Locking the copies** to open **Lock the copies**. Nothing leaves the server until you choose. Locking is [age](https://age-encryption.org) encryption; backups on the server stay as they are.
   1. Choose a passphrase of at least 12 characters, type it twice, tick **I have written the passphrase down**, press **Save passphrase**. The server keeps it (locked with the server's key file, below) so nightly backups run unattended.
   2. **Done** lists what a restore needs: a backup, the passphrase, the server's key file.

   **Without the passphrase nobody can open the copies, not even you.** Write it down and keep it away from this server.

   **Other ways**, in the first step:

   | Option | What it does |
   |---|---|
   | **Public key** | Run `age-keygen` on your computer, paste only the public key (`age1…`), press **Save public key**. The server holds no secret; a restore needs the private key. |
   | **Send without a lock** | Anyone who can read the storage can read your family's data. Only for storage you fully control. |
2. Press **Add a copy** and pick the kind:

   | Kind | Fields |
   |---|---|
   | **S3 storage** (Amazon S3, Backblaze B2, Wasabi, MinIO, Cloudflare R2) | **Server address**, **Region**, **Bucket**, optional **Folder in the bucket**, **Access key ID**, **Secret access key**. Switch on **Address the bucket by path** for MinIO and R2. Big backups upload in parts. |
   | **WebDAV** | **Folder address** (Nextcloud: `https://cloud.example/remote.php/dav/files/<user>/FamilyOS`), **User name**, **App password** (Nextcloud: Settings, Security). Use the exact address the server answers on; redirects are not followed. |
3. Press **Add**, open the copy, press **Test connection**, then **Back up now** at the top of the page.

**Good to know**
- Each copy shows when it last received a backup, or why not.
- A failed upload is retried up to 5 times over about 6 hours. Admins are notified when waiting cannot help (wrong password, no lock chosen) or retries run out.
- **Keep the last** (default 7) deletes older FamilyOS backups from that folder, never other files.
- Removing a target keeps the files it received. **Send backups here** off pauses it.

### The server's key file

Secrets FamilyOS keeps (AI keys, Telegram bot token, mailbox password, backup passphrase, calendar subscription addresses) are locked with the server's key file: `secret` in the data folder, or `FAMOS_SECRET` if set. Backups leave it out on purpose, so a stolen backup cannot open them. Keep a copy away from the server, such as in a password manager.

1. **Settings → System → Backups**, row **The server's key file**, press **Save the key file** (the last step of **Lock the copies** has the same button).
2. Enter your password. The file is saved to your device as `familyos-secret`.

Only an admin signed in with a password can do this. From a terminal:

```bash
docker compose cp famos:/data/secret ./familyos-secret
```

Without it, a restore brings back all data, but everyone signs in again and everything it locks stops until re-entered: AI keys, Telegram bot token, mailbox password, backup passwords and passphrase, calendar subscription addresses. Phone notifications stop too.

## Write a backup now

**Settings → System → Backups → Back up now** (also sends to your targets). **On this server** lists the newest, each marked **Nightly**, **Manual** or **Before a change to the data**. From a terminal (the running server sends it to your targets):

```bash
docker compose exec famos node /app/server/main.mjs backup
```

## Download a backup

Without a place to send copies, you can still keep one away from the server. Under **On this server**, press **Download** on a backup. The browser saves the `.tar` file to your device.

**Good to know**
- Only an admin signed in with a password can download, not on a PIN. Each download is written to the server's audit log.
- The file is not locked. It holds all of the family's data, photos and papers included. Keep it somewhere safe, such as an encrypted drive.
- The server's key file is not in it. Save that too (above).
- To restore it, put it back into the backups folder and follow **Restore** below.

## Restore

```bash
docker compose stop famos
docker compose run --rm famos restore /data/backups/<file>.tar
docker compose start famos
```

**Good to know**
- A copy from elsewhere, or one you downloaded, goes into the volume first: `docker compose cp ./file.tar famos:/data/backups/`.
- If the restore fails part way (a full disk, say), your current data is put back exactly as it was.
- Current data is never deleted: it is moved aside as `famos.db.pre-restore-<time>`, `files.pre-restore-<time>` and, if the backup holds them, `languages.pre-restore-<time>`, `themes.pre-restore-<time>`, `extensions.pre-restore-<time>`.
- A backup from a newer FamilyOS is refused.
- Extensions installed from a file come back and their signature is checked at start. If an older backup lacks one, it is left out (Settings lists it with the reason) and the rest starts. Install it again; its data was kept.

### After a restore: everyone signs in again

At the first start after a restore:
- Everyone is signed out, on every device.
- **What was ended after the backup stays ended**, while the replaced data (`famos.db.pre-restore-<time>`) is still next to the new: revoked app keys, removed devices, displays and members, stopped calendar addresses, unlinked Telegram chats. Passwords and PINs changed since stay changed.
- **Access taken away stays taken away.** For each person's role, archived state and what each role may do, the narrower of the backup and the day before is kept. Demotions, archiving and narrowed roles stay; promotions and widenings made after the backup are lost. If nobody could then manage settings, the earlier admins keep that access. Admins are told how many people kept their current access.
- **Connected apps are paused**, even on a new server. Admins review them in **Settings → Connected apps** and press **Resume** on trusted ones.
- Nothing is switched back on: keys, devices, addresses and links made after the backup are gone and must be made again.
- On a new server, or if you delete the `*.pre-restore-*` files before first start, only the sign-out happens.

If this step fails, the server does not start (otherwise the old sign-ins would work); start it again once the cause is fixed, and the step runs again.

Admins get a notification saying what stayed ended.

### Restoring an encrypted backup

Encrypted copies are `famos-<time>-<reason>.tar.age`. Restore asks for the passphrase, or reads `FAMOS_BACKUP_PASSPHRASE`:

```bash
docker compose run --rm -e FAMOS_BACKUP_PASSPHRASE='your passphrase' famos restore /data/backups/<file>.tar.age
```

For a public-key backup, give the private key from `age-keygen`:

```bash
docker compose run --rm -v ./key.txt:/key.txt famos restore /data/backups/<file>.tar.age --identity /key.txt
```

The file is standard age, so you can decrypt it anywhere with `age` and restore the `.tar` as above:

```bash
age -d -o backup.tar backup.tar.age          # asks for the passphrase
age -d -i key.txt -o backup.tar backup.tar.age   # with a private key
```

On **new hardware** you need the backup, the passphrase (or private key) and the server's key file. Put the saved file into the new data folder as `secret` before first start, then restore as above:

```bash
docker compose cp ./familyos-secret famos:/data/secret
```

If you set `FAMOS_SECRET` yourself, use the text inside the file as its value.
