# Deployment (Docker)

This app ships as a self-contained Docker image plus a `docker-compose.yml` that
also runs PostgreSQL and persistent volumes for the database and uploaded media.
Everything is self-hosted — no external services or tokens required.

## What's in the box

- **app** — the Next.js server (standalone build).
- **db** — PostgreSQL 16, data stored in the named volume `db-data`.
- **volumes** — `db-data` (database) and `media-data` (uploaded media at
  `/data/media`). Both survive rebuilds, restarts, and code updates.

On every container start, an **idempotent bootstrap** (`scripts/bootstrap-db.mjs`)
runs automatically. It only creates missing tables/columns and seeds your owner
license key. It **never drops or clears data**, so it's safe to run on every
deploy and update.

## First-time setup

1. Install Docker + Docker Compose on the server.
2. Copy the env template and fill it in:
   ```sh
   cp .env.example .env
   ```
   - Set `AUTH_SECRET` to a long random string: `openssl rand -hex 32`
   - Set a real `POSTGRES_PASSWORD` (and match it in `DATABASE_URL`).
   - `OWNER_LICENSE_KEY` is already your key (`a4726d28-…-f0606`). It is seeded
     on first boot and you log in with it.
3. Build and start:
   ```sh
   docker compose up -d --build
   ```
4. Open `http://YOUR_SERVER_IP:3000` (or whatever `APP_PORT` you set) and log in
   with your license key.

Put this behind a reverse proxy (Nginx/Caddy/Traefik) for TLS and your domain
(e.g. ythreads.online). The app listens on port 3000 inside the container.

> ⚠️ **Raise the proxy's max upload size.** The app accepts media uploads up to
> 100MB (the `bodySizeLimit` in `next.config.mjs`), but most reverse proxies cap
> request bodies far lower and will reject larger files with a `413` **before
> the request ever reaches the app**. This is the usual cause of "can't upload
> files bigger than ~1–10MB". Match the proxy limit to the app:
>
> - **Nginx** — in the `server` (or `location`) block:
>   ```nginx
>   client_max_body_size 100m;
>   ```
>   then `sudo nginx -t && sudo systemctl reload nginx`.
> - **Caddy** — in the site block:
>   ```
>   request_body {
>       max_size 100MB
>   }
>   ```
> - **Traefik** — add a `buffering` middleware:
>   `buffering.maxRequestBodyBytes = 104857600` (100MB) and attach it to the router.

## Updating the code (no DB reset, no data loss)

Because the database and media live in named volumes — not in the image — you
can rebuild the app as often as you like without touching your data:

```sh
git pull                       # get the new code
docker compose up -d --build   # rebuild + restart ONLY what changed
```

- `db-data` and `media-data` are untouched by a rebuild.
- The bootstrap migrates any new tables/columns automatically on startup.
- Compose recreates just the `app` container; the `db` container keeps running.

You never need to recreate or clear the database to ship an update.

> ⚠️ The only command that deletes data is `docker compose down -v` (the `-v`
> removes volumes). Use plain `docker compose down` to stop without data loss.

## Issuing licenses to other users

Log in as the owner and open **Admin** in the sidebar. Generate a key (it's
copied to your clipboard), then share it. Everything that user creates —
accounts, groups, workflows, warm-up jobs, publications, analytics, and uploaded
media — is isolated to their key. You can also add a license directly in SQL:

```sql
INSERT INTO users (license_key, label, is_admin)
VALUES ('<uuid>', 'Client name', false);
```

## Daily backups (so you can roll back)

Two scripts handle this. They store dumps in a plain host directory **outside
Docker volumes**, so backups survive even an accidental `docker compose down -v`.

- `scripts/backup-db.sh` — dumps the database to `BACKUP_DIR` (default
  `/srv/orbit-backups`) as a gzipped, self-restoring SQL file, and rotates out
  dumps older than `RETENTION_DAYS` (default 14).
- `scripts/restore-db.sh <dump>` — rolls the database back to a chosen dump.

### Run a backup manually

```sh
./scripts/backup-db.sh
# or choose a location / retention:
BACKUP_DIR=/srv/orbit-backups RETENTION_DAYS=30 ./scripts/backup-db.sh
```

### Schedule it once a day with host cron

`pg_dump` runs *inside* the db container, but cron runs on the **host**, so the
backup files land on the host disk. Edit the host crontab (`crontab -e`) and add:

```cron
# Every day at 03:00 — adjust the project path to where you cloned the repo.
0 3 * * * cd /opt/orbit && BACKUP_DIR=/srv/orbit-backups ./scripts/backup-db.sh >> /var/log/orbit-backup.log 2>&1
```

For extra safety, periodically copy `/srv/orbit-backups` off the server (rsync
to another machine, S3, etc.) so a disk failure can't take both the DB and its
backups.

### Roll back to a previous day

```sh
ls /srv/orbit-backups                                  # pick a dump
./scripts/restore-db.sh /srv/orbit-backups/orbit_2026-06-30_030000.sql.gz
docker compose restart app                             # reset the connection pool
```

The restore overwrites the current database with the dump's contents (it asks
for a `yes` confirmation first). Uploaded media in `media-data` is separate — if
you need point-in-time media too, also snapshot `/data/media` (e.g. `tar`/rsync)
on the same schedule.

## Using an external/managed Postgres instead of the bundled one

Set `DATABASE_URL` to your managed connection string and `DATABASE_SSL=require`
in `.env`, then you can remove the `db` service from `docker-compose.yml` (and
the `depends_on` block). The bootstrap and app work against any standard
PostgreSQL server.

## Media storage

Uploaded media is stored on the local filesystem under `MEDIA_ROOT`
(`/data/media` in Docker), partitioned per user, and served through an
authenticated route (`/api/media/...`) that checks the session. Nothing leaves
your server.
