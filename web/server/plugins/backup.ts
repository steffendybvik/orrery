// With backups on (NUXT_BACKUP_DIR or NUXT_BACKUP_DATABASE, or the folder or Postgres database chosen in App settings),
// backs the database up after a change (to a project, the settings and statuses, the owner's name, secrets or
// schedules), and on start. After a change means a few seconds after, unless the owner chose every 15 minutes, hour or
// day in App settings (ORR-445): then once that long has gone since the last backup, and only when something changed. A
// Postgres one, or one into Postgres, is copied whole each time, so it waits a minute after a change instead, for the
// rest that come with it.
export default defineNitroPlugin(nitro => {
    const log = useEventLog()
    let last = Date.now()
    // The database, the folder and how many to keep as they are each time, so a choice in App settings is followed.
    const save = () => {
        const target = backupTarget()
        if (!target) return Promise.resolve()
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
    save()
    for (const change of ['project', 'removed', 'settings', 'secrets', 'schedules']) projectEvents.on(change, soon)
    nitro.hooks.hook('close', async () => {
        clearTimeout(timer)
        await save()
        await closeBackupDb()
    })
})
