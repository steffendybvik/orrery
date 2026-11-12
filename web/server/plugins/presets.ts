// Adds the presets orrery ships that this orrery hasn't had yet (shared/presets.ts), through the Rust API
// (`POST /api/presets/seed`, ORR-1136): each time the API this server starts begins listening, at boot and on the
// database the owner moved to. With an API that runs on its own (NUXT_API_URL), as this server starts and after a move.
import {apiBinary} from '../utils/api-migrate'
import {onApiStarted, writeToApi} from '../utils/api-router'
import {ORRERY} from '../store/schema'

export default defineNitroPlugin(nitro => {
    const seed = () => void writeToApi('POST', '/api/presets/seed', {}, ORRERY, {always: true})
        .catch(error => console.error('[orrery] adding the presets orrery ships:', error))
    if (apiBinary()) {
        const stop = onApiStarted(seed)
        nitro.hooks.hook('close', stop)
        return
    }
    if (!useRuntimeConfig().apiUrl) return
    seed()
    projectEvents.on('database', seed)
    nitro.hooks.hook('close', () => void projectEvents.off('database', seed))
})
