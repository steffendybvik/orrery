// With backups on (NUXT_BACKUP_DIR or NUXT_BACKUP_DATABASE, or the folder or Postgres database chosen in App settings),
// backs the database up after a change (to a project, the settings and statuses, the owner's name, secrets or
// schedules), on start and as the server closes; when, and when not, is the scheduler's (utils/backup-scheduler.ts). A
// Postgres one, or one into Postgres, is copied whole each time, so it waits a minute after a change instead of a few
// seconds, for the rest that come with it.
export default defineNitroPlugin(nitro => {
    const log = useEventLog()
    const backups = new BackupScheduler({
        target: backupTarget,
        fresh: () => isFresh(useDatabase()),
        backUp: target => backUpTo(useDatabase(), target, backupKeep()),
        every: backupEvery,
        // Where the data is can change (a move from App settings), so how long to wait is worked out each time.
        settle: () => useDatabase() instanceof SqliteDb && backupTarget()?.kind !== 'postgres' ? 3000 : 60_000,
        note: entry => log.note(entry),
    })
    const save = () => backups.save()
    const soon = () => backups.soon()
    starting().catch(error => console.error('[orrery] checking the database on start:', error)).finally(save)
    for (const change of ['project', 'removed', 'settings', 'secrets', 'schedules']) projectEvents.on(change, soon)
    /** Notes the name it runs under in the database, for its backups to carry, and says so loudly when it starts empty:
     * there are backups to restore, or, in Docker, its data may be in a volume with another name. */
    async function starting() {
        const db = useDatabase()
        // Its id too, made now if it hasn't been asked for yet.
        await useStore().settings()
        await noteEnvironment(db, String(useRuntimeConfig().public.environment || 'personal'))
        if (!await isFresh(db)) return
        const target = backupTarget()
        const found = target?.kind === 'folder' ? listSnapshots(target.dir) : []
        const latest = found[0]
        const message = target && latest
            ? `This orrery's database is empty, and ${targetLabel(target)} has backups (the latest from ${latest.at}): open orrery to restore one, or start fresh`
            : inDocker() ? 'This orrery\'s database is empty. If it had data before, it may be in another Docker volume (a folder with another name gives another one): see `docker volume ls`'
                : ''
        if (!message) return
        console.warn(`[orrery] ${message}`)
        log.note({level: 'warn', kind: 'database.empty', message, details: {backups: found.length}})
    }
    nitro.hooks.hook('close', async () => {
        await backups.close()
        await closeBackupDb()
    })
})
