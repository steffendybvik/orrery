// With NUXT_BACKUP_DIR set, backs the database up a few seconds after each change (to a project, the
// settings and statuses, the owner's name, secrets or schedules), and on start. A Postgres one is copied
// whole each time, so it waits a minute after a change instead, for the rest that come with it.
export default defineNitroPlugin(nitro => {
    const dir = String(useRuntimeConfig().backupDir ?? '')
    if (!dir) return
    const log = useEventLog()
    // The database as it is each time, so one the owner moved to is backed up from then on.
    const save = () => backUp(useDatabase(), dir)
        .then(() => log.note({level: 'info', kind: 'backup.made', message: `Backed up to ${dir}`}), error => {
            console.error(`[orrery] backing up to ${dir}:`, error)
            log.note({level: 'error', kind: 'backup.failed', message: `Backing up to ${dir}: ${(error as Error).message}`, details: {stack: (error as Error).stack}})
        })
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
        clearTimeout(timer)
        timer = setTimeout(save, useDatabase() instanceof SqliteDb ? 3000 : 60_000)
    }
    save()
    for (const change of ['project', 'removed', 'settings', 'secrets', 'schedules']) projectEvents.on(change, soon)
    nitro.hooks.hook('close', async () => {
        clearTimeout(timer)
        await save()
    })
})
