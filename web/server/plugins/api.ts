// Starts the Rust API beside this server (ORR-922) when NUXT_API_BIN names its binary: on this server's database, once
// that's open and migrated (the API runs no migrations), on a loopback port of its own, with a token made fresh each
// start. It starts again on the new database when the owner moves it (ORR-1035), and stops with this server. Until it's
// listening, or if it can't start, this server answers its routes itself, or with the swap on (NUXT_API_ONLY, ORR-1034)
// holds them a few seconds for it, then fails them with a 503.
import {spawn} from 'node:child_process'
import {ApiProcess} from '../utils/api-process'
import {apiOnly} from '../utils/api-router'

export default defineNitroPlugin(nitro => {
    const bin = String(useRuntimeConfig().apiBin ?? '')
    if (!bin) return
    const api = new ApiProcess({
        spawn: env => spawn(bin, [], {env: {...process.env, ...env}, stdio: ['ignore', 'inherit', 'pipe']}),
        database: async () => {
            // Opening it migrates it; on Postgres a first query waits for that.
            await useDatabase().get('SELECT 1 AS one')
            return databaseSetting()
        },
        failed: error => console.error(`[orrery] can't start the Rust API (${bin}):`, error.message),
        stopped: code => console.error(`[orrery] the Rust API stopped (${code}); ${apiOnly(useRuntimeConfig()) ? 'its routes fail until it starts again (NUXT_API_ONLY)' : 'this server answers its routes now'}`),
    })
    const waited = (error: unknown) => console.error('[orrery] the Rust API waits on the database, which failed:', error)
    api.start().catch(waited)
    const moved = () => void api.restart().catch(waited)
    projectEvents.on('database', moved)
    nitro.hooks.hook('close', () => {
        projectEvents.off('database', moved)
        api.stop()
    })
})
