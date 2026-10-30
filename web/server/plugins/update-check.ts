// Asks GitHub whether a newer orrery is out (utils/update-check.ts, ORR-608): a few seconds after start, then every 12
// hours, unless ORRERY_UPDATE_CHECK=false turned it off.
export default defineNitroPlugin(nitro => {
    if (!isOn(useRuntimeConfig().updateCheck)) return
    const check = () => void useUpdateCheck().check()
    const first = setTimeout(check, 10_000)
    const timer = setInterval(check, UPDATE_EVERY)
    nitro.hooks.hook('close', () => {
        clearTimeout(first)
        clearInterval(timer)
    })
})

/** NUXT_UPDATE_CHECK as it comes: a boolean, or the string an env var leaves when it isn't one. */
function isOn(setting: unknown): boolean {
    return !['false', '0', 'no', 'off'].includes(String(setting).trim().toLowerCase())
}
