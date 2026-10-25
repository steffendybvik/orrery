// With NUXT_BACKUP_DIR set, backs the database up a few seconds after each change, and on start.
export default defineNitroPlugin(nitro => {
    const dir = String(useRuntimeConfig().backupDir ?? '')
    if (!dir) return
    // In line with the writes: `VACUUM INTO` can't run in the middle of a transaction.
    const save = () => useDatabase().alone(raw => backup(raw, dir))
        .catch(error => console.error(`[orrery] backing up to ${dir}:`, error))
    let timer: ReturnType<typeof setTimeout> | undefined
    const soon = () => {
        clearTimeout(timer)
        timer = setTimeout(save, 3000)
    }
    save()
    projectEvents.on('project', soon)
    projectEvents.on('removed', soon)
    nitro.hooks.hook('close', async () => {
        clearTimeout(timer)
        await save()
    })
})
