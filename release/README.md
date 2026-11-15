# orrery __VERSION__

A project board you share with your Claude Code sessions. This folder runs the published image with Docker.

```sh
cp .env.example .env    # optional: every setting has a default
docker compose up -d    # http://localhost:9000
```

The first time you open it, it asks your name: you're its owner. To connect Claude sessions you need Node 24 on this
machine, then follow the steps in [the README's Quick start](https://github.com/steffendybvik/orrery#quick-start) from step 2.

## Keep your data safe

- **Your data is in Docker.** The database lives in the `orrery_orrery-data` volume.
- **Back it up yourself:** orrery takes no backups. Stop it and `docker compose cp orrery:/data/orrery.db ./orrery-copy.db`,
  or see [Backups](https://github.com/steffendybvik/orrery/blob/main/docs/running.md#backups).
- **Never `docker compose down -v`**, and don't clear Docker Desktop's data, without a backup of yours: both delete
  the database. Plain `docker compose down` keeps it.
- **To update:** back it up, change the version in `compose.yml`'s `image:`, then `docker compose pull && docker compose up -d`.
- **To move to a new computer:** set it up the same way, and put your copy of the database where the new one's is.
- **If your data looks gone after an update:** run `docker volume ls`. A volume with another name (from an older
  setup in a folder with another name) may hold it.
