// Runs the schedules that are due: on start (so a schedule missed while Orrery was down runs once), then
// every 30 seconds.
export default defineNitroPlugin(nitro => {
    const tick = () => {
        try {
            useSchedules().runDue()
        } catch (error) {
            console.error('[orrery] running schedules:', error)
        }
    }
    const timer = setInterval(tick, 30_000)
    setTimeout(tick, 2_000)
    nitro.hooks.hook('close', () => clearInterval(timer))
})
