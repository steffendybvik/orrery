// With backups on (NUXT_BACKUP_DIR or NUXT_BACKUP_DATABASE, or the folder or Postgres database chosen in App settings),
// backs the database up after a change (to a project, the settings and statuses, the owner's name, secrets or
// schedules), and on start. After a change means a few seconds after, unless the owner chose every 15 minutes, hour or
// day in App settings (ORR-445): then once that long has gone since the last backup, and only when something changed. A
// Postgres one, or one into Postgres, is copied whole each time, so it waits a minute after a change instead, for the
// rest that come with it. A new orrery (no projects, no owner) doesn't back up over a folder that has a backup in it
// (ORR-448): its first page asks whether to restore one, and backing up the empty one first would put it in that one's
// place.
export default defineNitroPlugin(nitro => {
    const log = useEventLog()
    let last = Date.now()
    // The database, the folder and how many to keep as they are each time, so a choice in App settings is followed.
    const save = async () => {
        const target = backupTarget()
        if (!target) return
        if (target.kind === 'folder' && lastBackup(target.dir) && await isFresh(useDatabase()).catch(() => false)) return
        last = Date.now()
        // A Postgres one by `user@host:port/name`, never its password.
        const where = targetLabel(target)
        return backUpTo(useDatabase(), target, backupKeep())
            .then(() => log.note({level: 'info', kind: 'backup.made', message: `Backed up to ${where}`}), error => {
                console.error(`[orrery] backing up to ${where}:`, (error as Error).message)
                log.note({level: 'error', kind: 'backup.failed', message: `Backing up to ${where}: ${(error as Error).message}`, details: {stack: (error as Error).stack}})
            })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    // The first change not backed up yet.
    let since: number | undefined
    const soon = () => {
        const now = Date.now()
        since ??= now
        const every = backupEvery()
        // After each change, more changes put it off; on an interval, the backup already waiting takes them along.
        if (every !== 'change' && timer) return
        clearTimeout(timer)
        // Where the data is can change (a move from App settings), so how long to wait is worked out each time.
        const settle = useDatabase() instanceof SqliteDb && backupTarget()?.kind !== 'postgres' ? 3000 : 60_000
        timer = setTimeout(() => {
            timer = undefined
            since = undefined
            save()
        }, backupDelay(every, settle, now, since, last))
    }
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
        clearTimeout(timer)
        await save()
        await closeBackupDb()
    })
})
