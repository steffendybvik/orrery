// Starts the Rust API beside this server (ORR-922) when NUXT_API_BIN names its binary: on this server's database, once
// that's open and migrated (the API runs no migrations), on a loopback port of its own, with a token made fresh each
// start. It stops with this server. Until it's listening, or if it can't start, this server answers its routes itself.
import type {ChildProcess} from 'node:child_process'
import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {known} from '#shared/known'
import {apiStarted} from '../utils/api-router'

export default defineNitroPlugin(nitro => {
    const bin = String(useRuntimeConfig().apiBin ?? '')
    if (!bin) return
    let child: ChildProcess | null = null
    let stopping = false
    const start = async () => {
        // Opening it migrates it; on Postgres a first query waits for that.
        await useDatabase().get('SELECT 1 AS one')
        const token = randomBytes(24).toString('hex')
        const api = spawn(bin, [], {env: {...process.env, NUXT_API_TOKEN: token, NUXT_DATABASE: databaseSetting(), ORRERY_API_LISTEN: '127.0.0.1:0'}, stdio: ['ignore', 'inherit', 'pipe']})
        child = api
        let said = ''
        known(api.stderr ?? undefined, "the API's stderr").on('data', (chunk: Buffer) => {
            process.stderr.write(chunk)
            said += chunk
            const at = /serving docs on (http:\/\/\S+),/.exec(said)
            if (at) {
                apiStarted({url: known(at[1], 'the address it serves on'), token})
                said = ''
            }
        })
        api.on('error', error => console.error(`[orrery] can't start the Rust API (${bin}):`, error.message))
        api.on('exit', code => {
            apiStarted(null)
            if (!stopping) console.error(`[orrery] the Rust API stopped (${code}); this server answers its routes now`)
        })
    }
    start().catch(error => console.error('[orrery] the Rust API waits on the database, which failed:', error))
    nitro.hooks.hook('close', () => {
        stopping = true
        apiStarted(null)
        child?.kill()
    })
})
