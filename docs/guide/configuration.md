# Configuration

Most settings live in the app. The rest are environment variables the server reads at start; with Docker Compose, set them under `environment:` in `docker-compose.yml`.

| Variable | Default | Purpose |
|---|---|---|
| `FAMOS_BASE_URL` | `http://localhost:<PORT>` | The public address of this instance (cookies, origin checks, links). Must be HTTPS for phones |
| `FAMOS_SECRET` | generated into `/data/secret` | At least 32 characters. Signs sessions and encrypts saved keys and passwords. It is never inside a backup: keep a copy to restore on new hardware. Changing it signs everyone out and saved keys must be entered again. FamilyOS never overwrites an existing `secret` file: if it is shorter than 32 characters or unreadable, it refuses to start and tells you to restore the original, set `FAMOS_SECRET`, or move the file away |
| `FAMOS_SETUP_CODE` | generated into `/data/setup-code` | The one-time code first-run setup asks for (8 to 100 characters) |
| `FAMOS_TRUSTED_ORIGINS` | – | Extra allowed origins, comma-separated |
| `FAMOS_TRUSTED_PROXIES` | – | Reverse proxies (IPs or CIDRs, comma-separated) whose `X-Forwarded-For` is believed, for sign-in rate limits. Set it behind Caddy, Traefik or nginx |
| `FAMOS_ROLES` | `api,worker` | Run the API (`api`), the background worker (`worker`), or both |
| `FAMOS_DATA_DIR` | `./data` (`/data` in Docker) | Where the database, files, backups, packs and the generated secret live |
| `FAMOS_BACKUP_HOUR` / `FAMOS_BACKUP_KEEP` | `3` / `7` | Hour of the nightly backup and how many to keep ([Backups](backups.md)) |
| `FAMOS_BACKUP_PASSPHRASE` | – | Only for `restore` of an encrypted `.age` backup (otherwise it asks, or use `--identity <file>`) |
| `FAMOS_AI_PROVIDER` | – | `openrouter`, `ollama` or `openai-compatible`: one AI provider kept in line with these variables on every start (shown read-only in the app). Providers added in the app are separate |
| `FAMOS_AI_BASE_URL` / `FAMOS_AI_API_KEY` | the kind's default / – | That provider's address and key (stored encrypted) |
| `FAMOS_AI_MODEL` (and `_FAST`, `_VISION`, `_SMART`) | – | Its model for every role, or per role. Speech-to-text and search models are chosen in the app |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error` or `fatal` |
| `TZ` | `UTC` (compose) | Time zone of the container. The family's own time zone is set in the app |

**Good to know**
- `FAMOS_TELEGRAM_API_ROOT`, `FAMOS_EMAIL_FAKE_DIR` and `FAMOS_NOTIFY_DELAY_MS` exist for tests only; leave them unset.
- Providers set with `FAMOS_AI_*` apply on every start and cannot be changed in the app ([AI and privacy](ai.md)).
- Everything else lives in the `famos-data` volume ([Install](install.md)).

## Backups from a terminal

A backup is written every night and before every change to the data. By hand:

```bash
docker compose exec famos node /app/server/main.mjs backup
docker compose stop famos
docker compose run --rm famos restore /data/backups/<file>.tar
docker compose start famos
```

Restoring never deletes the current data; it is kept next to it as `*.pre-restore-<timestamp>`. Encrypted copies, restoring on new hardware and what a restore ends are in [Backups](backups.md).
