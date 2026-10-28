// With backups on (NUXT_BACKUP_DIR, or the folder chosen in App settings), backs the database up after a change (to a
// project, the settings and statuses, the owner's name, secrets or schedules), and on start. After a change means a few
// seconds after, unless the owner chose every 15 minutes, hour or day in App settings (ORR-445): then once that long has
// gone since the last backup, and only when something changed. A Postgres one is copied whole each time, so it waits a
// minute after a change instead, for the rest that come with it.
export default defineNitroPlugin(nitro => {
    const log = useEventLog()
    let last = Date.now()
    // The database, the folder and how many to keep as they are each time, so a choice in App settings is followed.
    const save = () => {
        const dir = backupDir()
        if (!dir) return Promise.resolve()
        last = Date.now()
        return backUp(useDatabase(), dir, backupKeep())
            .then(() => log.note({level: 'info', kind: 'backup.made', message: `Backed up to ${dir}`}), error => {
                console.error(`[orrery] backing up to ${dir}:`, error)
                log.note({level: 'error', kind: 'backup.failed', message: `Backing up to ${dir}: ${(error as Error).message}`, details: {stack: (error as Error).stack}})
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
        const settle = useDatabase() instanceof SqliteDb ? 3000 : 60_000
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
    })
})
