// Closes the database as the server stops, after the backup plugin's last copy (plugins run in name
// order), so a reloaded server in `nuxt dev` can open it straight away.
export default defineNitroPlugin(nitro => {
    nitro.hooks.hook('close', () => closeDb())
})
