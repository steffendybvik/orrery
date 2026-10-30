# orrery __VERSION__

A self-hosted roadmap board for working with Claude Code sessions. This folder runs the published image with Docker.

```sh
cp .env.example .env    # optional: every setting has a default
docker compose up -d    # http://localhost:9000
```

The first time you open it, it asks your name: you're its owner. To connect Claude sessions you need Node 24 on this
machine, then follow the steps in [the README's Quick start](https://github.com/steffendybvik/orrery#quick-start) from step 2.

## Keep your data safe

- **Your data and its backups are in Docker.** The database lives in the `orrery_orrery-data` volume. A checked
  copy goes to the `orrery_orrery-backup` volume a few seconds after each change, plus one a day for two weeks.
- **Set `ORRERY_BACKUP` to a folder that leaves this computer:** iCloud Drive, Dropbox, or a folder Time Machine
  covers. The volume is on the same disk as the data. On Linux, make the folder first: orrery runs as uid 1000, and a
  folder Docker makes is root's.
- **Never `docker compose down -v`**, and don't clear Docker Desktop's data, without a backup in a folder of yours:
  both delete the database and the backup volume. Plain `docker compose down` keeps them.
- **To update:** change the version in `compose.yml`'s `image:`, then `docker compose pull && docker compose up -d`.
  orrery takes a copy before it upgrades the database.
- **To move to a new computer:** set it up the same way, point `ORRERY_BACKUP` at the same folder, and choose the
  backup to restore when it first opens.
- **If your data looks gone after an update:** run `docker volume ls`. A volume with another name (from an older
  setup in a folder with another name) may hold it. App settings → This orrery → Database → **Restore a backup…** brings back any
  backup in the folder.
