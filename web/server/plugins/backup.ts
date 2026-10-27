// With NUXT_BACKUP_DIR set, backs the database up a few seconds after each change (to a project, the
// settings and statuses, the owner's name, secrets or schedules), and on start.
export default defineNitroPlugin(nitro => {
    const dir = String(useRuntimeConfig().backupDir ?? '')
    // Postgres is backed up by its own means (a managed service's backups, pg_dump on a schedule).
    const database = useDatabase()
    if (!dir || !(database instanceof SqliteDb)) return
    // In line with the writes: `VACUUM INTO` can't run in the middle of a transaction.
    const log = useEventLog()
    const save = () => database.alone(raw => backup(raw, dir))
        .then(() => log.note({level: 'info', kind: 'backup.made', message: `Backed up to ${dir}`}), error => {
            console.error(`[orrery] backing up to ${dir}:`, error)
            log.note({level: 'error', kind: 'backup.failed', message: `Backing up to ${dir}: ${(error as Error).message}`, details: {stack: (error as Error).stack}})
        })
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
        clearTimeout(timer)
        timer = setTimeout(save, 3000)
    }
    save()
    for (const change of ['project', 'removed', 'settings', 'secrets', 'schedules']) projectEvents.on(change, soon)
    nitro.hooks.hook('close', async () => {
        clearTimeout(timer)
        await save()
    })
})
