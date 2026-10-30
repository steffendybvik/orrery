// The key the secrets are sealed with (ORR-614): ORRERY_SECRET_KEY (NUXT_SECRET_KEY) when the owner set one, else one
// orrery made on its first start and keeps in a file of its own, `orrery.key`, readable by its owner alone. The file
// sits in the folder of the SQLite file NUXT_DATABASE names, so a move from App settings leaves it where it is; in
// Docker that's /data, on SQLite or Postgres alike, so a switch between them keeps it. Backups and `orrery:copy` take
// the database only, so it's never in one: lose the file and the secrets sealed with it don't open again.
import {randomBytes} from 'node:crypto'
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {isPostgres} from './postgres'

/** Where a made key is kept for the database NUXT_DATABASE names; none outside Docker on Postgres, which has no data
 * folder of orrery's to keep it in (set ORRERY_SECRET_KEY there). */
export function secretKeyFile(database: string, docker: boolean): string | null {
    if (!isPostgres(database)) return join(dirname(resolve(database)), 'orrery.key')
    return docker ? '/data/orrery.key' : null
}

/** The key: `set` when it isn't empty; else the one in `file`, made there first (32 random bytes, base64) when there's
 * none. Empty when there's no file to keep one in, or it can't be written: secrets then say they need a key. */
export function secretKey(set: string, file: string | null): string {
    if (set) return set
    if (!file) return ''
    try {
        if (existsSync(file)) return readFileSync(file, 'utf8').trim()
        mkdirSync(dirname(file), {recursive: true})
        const key = randomBytes(32).toString('base64')
        // `wx`: two starting at once don't each write their own; the second reads the first's.
        writeFileSync(file, `${key}\n`, {mode: 0o600, flag: 'wx'})
        chmodSync(file, 0o600)
        return key
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(file, 'utf8').trim()
        console.error(`[orrery] making the secrets' key in ${file}:`, error)
        return ''
    }
}
