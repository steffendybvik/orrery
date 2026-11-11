// The Rust API runs the migrations (ORR-931): before this server opens a database, `orrery-api migrate` brings it up to
// date, so the steps that run are the crate's (api/migrations, api/src/migrate.rs). This server's own steps then find
// nothing to do. They still run when there's no binary to ask (the tests, a bare `nuxt dev`), or when the binary's steps
// end at a different one from this server's (a stale `cargo build`): then this server says so and migrates as before.
import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
import {backupDir} from './backup-choice'

/** The repo's own debug build of the API, from web/ where `nuxt dev` runs. */
const DEV_BIN = resolve(process.cwd(), '../api/target/debug/orrery-api')

/** The Rust API's binary: NUXT_API_BIN, or under `nuxt dev` the repo's own build when no API is named to use instead
 * (NUXT_API_URL and NUXT_API_TOKEN); empty when there's none. Not api-router's `apiTarget`: that's this server's own
 * once it has started one, and api-router would bring its imports into everything that opens the database. */
export function apiBinary(): string {
    const config = useRuntimeConfig()
    const named = Boolean(config.apiUrl && config.apiToken)
    const devBin = import.meta.dev && !named && existsSync(DEV_BIN) ? DEV_BIN : ''
    return String(config.apiBin || devBin)
}

export type Migrated = {from: number, to: number}

/** Brings `setting`'s database (a SQLite file or a `postgres://` URL) up to `steps` with `orrery-api migrate`. Says what
 * it did, null when it was up to date already, or undefined when it ran nothing and this server is to migrate it: no
 * binary, one that won't start, or one whose steps end elsewhere. A migration that fails throws, as this server's own
 * does, and nothing else then tries it. */
export function migrateWithApi(setting: string, steps: number, bin = apiBinary()): Migrated | null | undefined {
    if (!bin) return undefined
    const run = spawnSync(bin, ['migrate'], {
        env: {
            ...process.env, NUXT_DATABASE: setting, ORRERY_API_STEPS: String(steps),
            // The copy before an upgrade goes where this server's would (`beforeUpgrade`), and is named the same.
            ORRERY_API_BACKUP_DIR: backupDir(), ORRERY_VERSION: String(useRuntimeConfig().public?.version ?? ''),
        },
        encoding: 'utf8',
    })
    const said = (run.stderr ?? '').trim().replace(/^\[orrery-api\] /gm, '')
    if (run.error) {
        console.error(`[orrery] can't run ${bin} to migrate the database, so this server does:`, run.error.message)
        return undefined
    }
    if (run.status === 3) {
        console.error(`[orrery] ${bin} doesn't match this server (${said}), so this server migrates the database itself`)
        return undefined
    }
    if (run.status !== 0) throw new Error(said || `${bin} migrate stopped (${run.status ?? run.signal})`)
    const done = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as Migrated
    return done.from < done.to ? done : null
}
