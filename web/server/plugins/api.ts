// Starts the Rust API beside this server (ORR-922) when NUXT_API_BIN names its binary: on this server's database, once
// that's open and migrated (by this same binary's `migrate` as it opened, utils/api-migrate.ts), on a loopback port of
// its own, with a token made fresh each start. It starts again on the new database when the owner moves it (ORR-1035),
// and stops with this server. Until it's listening a request for its routes waits a few seconds for it, then fails with
// a 503: most of them are its alone, as their routes here are gone (ORR-1041). The image sets NUXT_API_BIN; `nuxt dev`
// takes the repo's own build (`cargo build` in api/) when it's unset, so the dev server and the browser suite have the
// API without saying so.
import {spawn} from 'node:child_process'
import {ApiProcess} from '../utils/api-process'
import {apiBinary} from '../utils/api-migrate'
import {apiTarget} from '../utils/api-router'

export default defineNitroPlugin(nitro => {
    const config = useRuntimeConfig()
    // An API already running (NUXT_API_URL and NUXT_API_TOKEN) is used as it is.
    const bin = apiBinary()
    if (!bin) {
        if (!apiTarget(config)) console.error('[orrery] no Rust API: set NUXT_API_BIN (or run `cargo build` in api/ for `nuxt dev`), or NUXT_API_URL and NUXT_API_TOKEN; most routes fail with a 503 until then')
        return
    }
    const api = new ApiProcess({
        spawn: env => spawn(bin, [], {env: {...process.env, ...env}, stdio: ['ignore', 'inherit', 'pipe']}),
        database: async () => {
            // Opening it migrates it; on Postgres a first query waits for that.
            await useDatabase().get('SELECT 1 AS one')
            return databaseSetting()
        },
        failed: error => console.error(`[orrery] can't start the Rust API (${bin}):`, error.message),
        stopped: code => console.error(`[orrery] the Rust API stopped (${code}); its routes fail until it starts again`),
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
