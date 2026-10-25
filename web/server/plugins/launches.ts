import type {Signal} from '#shared/roadmap'

// Starts a session for the owner's signal when nobody on its project is there to hear it (see utils/launches.ts).
export default defineNitroPlugin(() => {
    projectEvents.on('signal', (signal: Signal) => {
        considerLaunch(signal).catch(error => console.error(`[orrery] starting a session for ${signal.project}:`, error))
    })
})
