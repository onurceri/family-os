# Backups

A nightly backup, copies sent elsewhere, and how to bring one back.

**Good to know**
- A backup runs every night at 03:00 by default (`FAMOS_BACKUP_HOUR`) and the last 7 nightly ones are kept (`FAMOS_BACKUP_KEEP`). The hour is the server's local time; in the container that is UTC unless you set `TZ` in `docker-compose.yml`.
- One is also written before every change to the data, such as an update or installing an extension. The last 3 of those are kept apart from the nightly ones, so they never take their places.
- Backups you start yourself are never deleted automatically.
- A backup is a single `.tar` file in `/data/backups` with the database, all shared files, installed language and theme packs, extensions installed from a file and a checksum.
- Backups on the server are not encrypted; they sit next to the database they came from.

## Send copies somewhere else

A backup on the same disk does not survive a broken disk or a stolen server. Admins can send every nightly backup elsewhere under **Settings → System → Backups**.

1. **Lock the copies first.** Tap the row under **Locking the copies**; the panel **Lock the copies** walks you through it. Nothing leaves the server until you choose. Locking is encryption with [age](https://age-encryption.org): only someone with the passphrase can open a copy, not the storage company and not anyone who finds the file. Backups kept on the server stay as they are.
   1. **Choose a passphrase.** A long password of a few words, at least 12 characters. You type it twice and tick **I have written the passphrase down**, then press **Save passphrase**. The server keeps it (locked with the server's key file, see below) so nightly backups run unattended.
   2. **Done** lists what you need to bring a backup back: a backup, the passphrase, and the server's key file.

   **Without this passphrase nobody can open the copies.** Write it down and keep it away from this server. You will be asked for it when a backup is brought back, maybe years from now.

   **Other ways** in the first step:

   | Option | What it does |
   |---|---|
   | **Public key** | For people who use the age tool. Create a key pair on your own computer with `age-keygen`, paste only the public key (`age1…`) and press **Save public key**. The server holds no secret for your backups; you need the private key to restore. |
   | **Send without a lock** | Anyone who can read the storage can read your family's data. Choose it only for storage you fully control. |
2. Press **Add a copy** and pick the kind:

   | Kind | Fields |
   |---|---|
   | **S3 storage** (Amazon S3, Backblaze B2, Wasabi, MinIO, Cloudflare R2) | **Server address**, **Region**, **Bucket**, optional **Folder in the bucket**, **Access key ID**, **Secret access key**. Switch on **Address the bucket by path** for MinIO and R2. Big backups are uploaded in parts. |
   | **WebDAV** | **Folder address** (Nextcloud: `https://cloud.example/remote.php/dav/files/<user>/FamilyOS`), **User name**, **App password** (Nextcloud: Settings, Security). Use the exact address the server answers on; redirects are not followed. |
3. Press **Add**. Tap the copy to open it, press **Test connection**, then press **Back up now** at the top of the page.

**Good to know**
- Each copy shows when it last received a backup, or why it did not.
- A failed upload is retried up to 5 times over about 6 hours. If waiting cannot help (wrong password, no lock chosen) or the retries run out, admins get a notification.
- **Keep the last** sets how many copies a target keeps (7 by default). Older FamilyOS backups in that folder are deleted, never other files.
- Removing a target leaves the files it already received. To pause one, switch off **Send backups here**.

### The server's key file

FamilyOS keeps some secrets for you (AI keys, the Telegram bot token, the mailbox password, the backup passphrase, calendar subscription addresses), locked with **the server's key file**: the file `secret` in the data folder, or `FAMOS_SECRET` if whoever installed FamilyOS set it. Backups leave this file out on purpose, so a stolen backup cannot open them. Keep a copy somewhere safe away from the server, for example in a password manager.

1. Go to **Settings → System → Backups**, row **The server's key file**, and press **Save the key file**. The last step of **Lock the copies** has the same button.
2. Enter your password when asked. The file is saved to the device you are using as `familyos-secret`.

Only an admin who signed in with a password can do this. From a terminal:

```bash
docker compose cp famos:/data/secret ./familyos-secret
```

Without the key file, a restore still brings back all data, but everyone must sign in again, and everything locked with it stops working until you enter it again: AI keys, the Telegram bot token, the mailbox password, backup passwords and the passphrase, calendar subscription addresses. Phone notifications stop as well.

## Write a backup now

Press **Settings → System → Backups → Back up now**; it also sends the copy to your targets. The list under **On this server** shows the newest ones, each marked **Nightly**, **Manual** or **Before a change to the data**. From a terminal (the running server sends that copy to your targets):

```bash
docker compose exec famos node /app/server/main.mjs backup
```

## Restore

```bash
docker compose stop famos
docker compose run --rm famos restore /data/backups/<file>.tar
docker compose start famos
```

**Good to know**
- To restore a copy from elsewhere, put it into the volume first: `docker compose cp ./file.tar famos:/data/backups/`.
- Restoring never deletes the current data. It is moved aside as `famos.db.pre-restore-<time>`, `files.pre-restore-<time>` and, if the backup holds language or theme packs or extensions installed from a file, `languages.pre-restore-<time>`, `themes.pre-restore-<time>` and `extensions.pre-restore-<time>`.
- A backup from a newer FamilyOS is refused.
- Extensions installed from a file come back with the backup, and their signature is checked again at start. A backup from an older FamilyOS that does not hold them still restores: an extension it lists as installed but this server has no package of is left out (Settings lists it with the reason) and everything else starts as usual. Install it again to bring it back; its data was kept.

### After a restore: everyone signs in again

A backup is a picture of an earlier day, and a restore must not undo what the family ended since. At the first start after a restore:

- Everyone is signed out and signs in again, on every phone, tablet and computer.
- **What was ended after the backup stays ended**, as long as the replaced data is still next to the new one (`famos.db.pre-restore-<time>`): revoked app keys, removed devices, displays and members, stopped calendar addresses, unlinked Telegram chats. A password or PIN changed after the backup stays changed, so a password changed after a leak does not come back.
- **Access taken away stays taken away.** For each person's role, whether a person is archived, and what each role may do, the narrower of the backup and the day before the restore is kept. A person you demoted or archived and a role you narrowed stay that way; a promotion or widening made after the backup is lost, like the rest of that day. If nobody would be able to manage settings, the people who were admins before the restore keep that access too. Admins are told how many people kept the access they have now.
- **Connected apps are paused**, even on a new server, because a backup can hold the key of an app revoked, replaced or leaked since. Admins review them in **Settings → Connected apps** and press **Resume** on the ones they trust.
- Nothing is ever switched back on. Keys, devices, addresses and links made after the backup are gone, and a person must make them again.
- On a new server, where nothing was set aside, only the sign-out happens. The same is true if you delete the `*.pre-restore-*` files before the first start.

Admins get a notification that says what stayed ended.

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

On **new hardware** you need three things: the backup, the passphrase (or private key), and the server's key file (`secret`, or your `FAMOS_SECRET`). Put the file you saved with **Save the key file** into the new data folder as `secret` before the first start, and restore as above:

```bash
docker compose cp ./familyos-secret famos:/data/secret
```

If you set `FAMOS_SECRET` yourself, use the text inside the file as its value instead.
