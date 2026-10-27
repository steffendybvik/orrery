// With NUXT_BACKUP_DIR set, backs the database up a few seconds after each change (to a project, the
// settings and statuses, the owner's name, secrets or schedules), and on start. A Postgres one is copied
// whole each time, so it waits a minute after a change instead, for the rest that come with it.
export default defineNitroPlugin(nitro => {
    const dir = String(useRuntimeConfig().backupDir ?? '')
    if (!dir) return
    const database = useDatabase()
    const save = () => backUp(database, dir).catch(error => console.error(`[orrery] backing up to ${dir}:`, error))
    const wait = database instanceof SqliteDb ? 3000 : 60_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
        clearTimeout(timer)
        timer = setTimeout(save, wait)
    }
    save()
    for (const change of ['project', 'removed', 'settings', 'secrets', 'schedules']) projectEvents.on(change, soon)
    nitro.hooks.hook('close', async () => {
        clearTimeout(timer)
        await save()
    })
})
