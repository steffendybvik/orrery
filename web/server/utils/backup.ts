// A copy of the database in another folder (`NUXT_BACKUP_DIR`, e.g. in iCloud Drive), so it's saved
// off the machine. The live file stays local: a synced SQLite file gets corrupted, a snapshot doesn't.
// `orrery.db` there is always the latest; `orrery-YYYY-MM-DD.db` keeps one a day for two weeks.
import {copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import type {DatabaseSync} from 'node:sqlite'

const LATEST = 'orrery.db'
const DAILY = /^orrery-\d{4}-\d{2}-\d{2}\.db$/
const KEEP_DAYS = 14

/** Writes a consistent copy of `db` to `dir`, then today's copy if there isn't one yet. */
export function backup(db: DatabaseSync, dir: string) {
    mkdirSync(dir, {recursive: true})
    const temporary = join(dir, '.orrery.db.partial')
    rmSync(temporary, {force: true})
    db.prepare('VACUUM INTO ?').run(temporary)
    renameSync(temporary, join(dir, LATEST))

    const today = join(dir, `orrery-${new Date().toISOString().slice(0, 10)}.db`)
    if (!existsSync(today)) copyFileSync(join(dir, LATEST), today)
    readdirSync(dir).filter(name => DAILY.test(name)).sort().slice(0, -KEEP_DAYS).forEach(name => rmSync(join(dir, name)))
}

/** A database that isn't there yet (a new machine, a fresh volume) starts from the backup. */
export function restoreBackup(path: string, dir: string) {
    if (!dir || existsSync(path) || !existsSync(join(dir, LATEST))) return
    mkdirSync(join(path, '..'), {recursive: true})
    copyFileSync(join(dir, LATEST), path)
    console.info(`[orrery] restored the database from ${join(dir, LATEST)}`)
}
