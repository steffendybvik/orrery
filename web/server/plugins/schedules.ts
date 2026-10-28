import type {OrreryEvent} from '#shared/happenings'

// Runs the schedules that are due: on start (so a schedule missed while orrery was down runs once), then
// every 30 seconds; and those that run on an event, as each happens.
export default defineNitroPlugin(nitro => {
    const tick = async () => {
        try {
            await useScheduler().runDue()
        } catch (error) {
            console.error('[orrery] running schedules:', error)
        }
    }
    const timer = setInterval(tick, 30_000)
    setTimeout(tick, 2_000)
    const hear = ({event, cause}: {event: OrreryEvent, cause?: number}) => {
        useScheduler().hear(event, cause).catch(error => console.error(`[orrery] running schedules on ${event.type}:`, error))
    }
    projectEvents.on('happened', hear)
    nitro.hooks.hook('close', () => {
        clearInterval(timer)
        projectEvents.off('happened', hear)
    })
})
