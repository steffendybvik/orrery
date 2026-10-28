// With NUXT_BACKUP_DIR set, backs the database up a few seconds after each change (to a project, the
// settings and statuses, the owner's name, secrets or schedules), and on start. A Postgres one is copied
// whole each time, so it waits a minute after a change instead, for the rest that come with it.
export default defineNitroPlugin(nitro => {
    const dir = String(useRuntimeConfig().backupDir ?? '')
    if (!dir) return
    const database = useDatabase()
    const log = useEventLog()
    const save = () => backUp(database, dir)
        .then(() => log.note({level: 'info', kind: 'backup.made', message: `Backed up to ${dir}`}), error => {
            console.error(`[orrery] backing up to ${dir}:`, error)
            log.note({level: 'error', kind: 'backup.failed', message: `Backing up to ${dir}: ${(error as Error).message}`, details: {stack: (error as Error).stack}})
        })
    const wait = database instanceof SqliteDb ? 3000 : 60_000
    let timer: ReturnType<typeof setTimeout> | undefined
    // Changes that keep coming put it off, but never past ten waits from the first of them.
    let since: number | undefined
    const soon = () => {
        since ??= Date.now()
        clearTimeout(timer)
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
    })
})
