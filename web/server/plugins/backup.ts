// With backups on (NUXT_BACKUP_DIR or NUXT_BACKUP_DATABASE, or the folder or Postgres database chosen in App settings),
// backs the database up a few seconds after each change (to a project, the settings and statuses, the owner's name,
// secrets or schedules), and on start. A Postgres one, or one into Postgres, is copied whole each time, so it waits a
// minute after a change instead, for the rest that come with it.
export default defineNitroPlugin(nitro => {
    const log = useEventLog()
    // The database and the folder as they are each time, so a move or a new folder from App settings is followed.
    const save = () => {
        const target = backupTarget()
        if (!target) return Promise.resolve()
        // A Postgres one by `user@host:port/name`, never its password.
        const where = targetLabel(target)
        return backUpTo(useDatabase(), target)
            .then(() => log.note({level: 'info', kind: 'backup.made', message: `Backed up to ${where}`}), error => {
                console.error(`[orrery] backing up to ${where}:`, (error as Error).message)
                log.note({level: 'error', kind: 'backup.failed', message: `Backing up to ${where}: ${(error as Error).message}`, details: {stack: (error as Error).stack}})
            })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    // Changes that keep coming put it off, but never past ten waits from the first of them.
    let since: number | undefined
    const soon = () => {
        since ??= Date.now()
        clearTimeout(timer)
        // Where the data is can change (a move from App settings), so how long to wait is worked out each time.
        const wait = useDatabase() instanceof SqliteDb && backupTarget()?.kind !== 'postgres' ? 3000 : 60_000
        timer = setTimeout(() => {
            since = undefined
            save()
        }, Math.max(0, Math.min(wait, since + 10 * wait - Date.now())))
    }
    save()
    for (const change of ['project', 'removed', 'settings', 'secrets', 'schedules']) projectEvents.on(change, soon)
    nitro.hooks.hook('close', async () => {
        clearTimeout(timer)
        await save()
        await closeBackupDb()
    })
})
