import type {Signal} from '#shared/roadmap'

// Starts a session for the owner's signal when nobody on its project is there to hear it, and every 30 seconds
// stops those whose time is up or that have sat idle too long, once they're done, and starts any replacement still
// waiting for room or a launcher (see utils/launches.ts).
export default defineNitroPlugin(nitro => {
    projectEvents.on('signal', (signal: Signal) => {
        considerLaunch(signal).catch(error => console.error(`[orrery] starting a session for ${signal.project}:`, error))
    })
    const timer = setInterval(() => {
        stopDue().catch(error => console.error('[orrery] stopping sessions that are done:', error))
        keepMinimum().catch(error => console.error('[orrery] keeping the minimum of sessions running:', error))
    }, 30_000)
    nitro.hooks.hook('close', () => clearInterval(timer))
})
