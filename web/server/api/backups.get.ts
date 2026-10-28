// `GET /api/backups` → `{snapshots, fresh, restorable, environment, docker}`: the copies in the backup folder, newest
// first (`{name, kind, at, size, of?, environment?, projects?}`, see server/utils/restore.ts), whether this orrery is
// a new one's (no projects, no owner: it asks before starting from one, ORR-448), whether the app can restore one
// (a SQLite orrery, whose database ORRERY_DATABASE doesn't set to Postgres), the name it runs under, and whether it
// runs in Docker (where data that seems gone may be in another volume).
export default defineEventHandler(async () => {
    const dir = backupTarget()?.kind === 'folder' ? backupDir() : ''
    return {
        snapshots: listSnapshots(dir),
        fresh: await isFresh(useDatabase()),
        restorable: !!dir && !!movedFile() && !isPostgres(databaseSetting()),
        environment: String(useRuntimeConfig().public.environment || 'personal'),
        docker: inDocker(),
    }
})
