# orrery __VERSION__

A self-hosted roadmap board for working with Claude Code sessions. This folder runs the published image with Docker.

```sh
cp .env.example .env    # optional: every setting has a default
mkdir -p backups        # on Linux: Docker would make it root's, and orrery runs as uid 1000
docker compose up -d    # http://localhost:9000
```

The first time you open it, it asks your name: you're its owner. To connect Claude sessions, clone the repo
(https://github.com/steffendybvik/orrery) and follow its README from "Connect a repo".

## Keep your data safe

- **Your data is in Docker; your backups are in `ORRERY_BACKUP`.** The database lives in the `orrery_orrery-data`
  volume. A checked copy goes to the backup folder a few seconds after each change, plus one a day for two weeks.
- **Put `ORRERY_BACKUP` somewhere that leaves this computer:** iCloud Drive, Dropbox, or a folder Time Machine
  covers. The default, `./backups` beside `compose.yml`, is on the same disk as the data.
- **Never `docker compose down -v`**, and don't clear Docker Desktop's data, without a recent backup: both delete the
  database. Plain `docker compose down` keeps it.
- **To update:** change the version in `compose.yml`'s `image:`, then `docker compose pull && docker compose up -d`.
  orrery takes a copy before it upgrades the database.
- **To move to a new computer:** set it up the same way, point `ORRERY_BACKUP` at the same folder, and choose the
  backup to restore when it first opens.
- **If your data looks gone after an update:** run `docker volume ls`. A volume with another name (from an older
  setup in a folder with another name) may hold it. App settings → Database → **Restore a backup…** brings back any
  backup in the folder.
