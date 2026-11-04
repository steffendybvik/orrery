// Writes the feature counts gathered in memory once a minute, and once more as orrery stops (ORR-881).
export default defineNitroPlugin(nitro => {
    const timer = setInterval(() => flushUse().catch(error => console.error('[orrery] writing feature use:', error)), 60_000)
    timer.unref?.()
    nitro.hooks.hook('close', async () => {
        clearInterval(timer)
        await flushUse().catch(() => {})
    })
})
