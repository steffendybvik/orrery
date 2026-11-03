// Restoring from a backup (ORR-448): the copies in the backup folder, listed with what's in them, and one of them put
// back, never without the owner choosing it. A database that's empty (no projects, no owner) and finds backups asks
// before anything else, instead of starting from one silently: a backup folder another orrery shares, or a volume
// with a new name after an update, would otherwise bring the wrong data back and look fine. The restore runs on a copy
// of the chosen snapshot, in a new file beside the database, after a copy of the database as it was went in the backup
// folder (`orrery-pre-restore-<time>.db`); the file it ran on stays as it was.
import {copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import type {Db} from './database'
import {SqliteDb} from './database'
import type {Snapshot} from '#shared/roadmap'
import {checkSnapshot} from './backup'

const KINDS: [RegExp, Snapshot['kind']][] = [[/^orrery\.db$/, 'latest'], [/^orrery-\d{4}-\d{2}-\d{2}\.db$/, 'daily'], [/^orrery-pre-.+\.db$/, 'before']]

/** The kind of copy `name` is, or none for any other file. */
const kindOf = (name: string) => KINDS.find(([pattern]) => pattern.test(name))?.[1]

/** What a copy says about itself, read without writing to it. */
function inside(path: string): Pick<Snapshot, 'of' | 'environment' | 'projects'> {
    let opened: DatabaseSync | undefined
    try {
        opened = new DatabaseSync(path, {readOnly: true})
        const settings = Object.fromEntries((opened.prepare('SELECT key, value FROM settings WHERE key IN (\'id\', \'environment\')').all() as {key: string, value: string}[])
            .map(row => [row.key, JSON.parse(row.value) as string]))
        const {n} = opened.prepare('SELECT count(*) AS n FROM projects').get() as {n: number}
        return {...settings.id ? {of: settings.id} : {}, ...settings.environment ? {environment: settings.environment} : {}, projects: Number(n)}
    } catch {
        return {}
    } finally {
        opened?.close()
    }
}

/** What each copy said about itself, by path, while its file is unchanged (its time and size): a year of daily copies
 * isn't opened again on each list (ORR-483). */
const read = new Map<string, {at: number, size: number, said: ReturnType<typeof inside>}>()

/** The copies in `dir`, newest first. */
export function listSnapshots(dir: string): Snapshot[] {
    if (!dir || !existsSync(dir)) return []
    const listed = new Set<string>()
    const found = readdirSync(dir).flatMap(name => {
        const kind = kindOf(name)
        if (!kind) return []
        const path = join(dir, name)
        const stat = statSync(path)
        listed.add(path)
        let known = read.get(path)
        if (known?.at !== stat.mtimeMs || known.size !== stat.size) read.set(path, known = {at: stat.mtimeMs, size: stat.size, said: inside(path)})
        return [{name, kind, at: stat.mtime.toISOString(), size: stat.size, ...known.said}]
    }).sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name))
    // Copies pruned since are forgotten.
    for (const path of read.keys()) if (dirname(path) === dir && !listed.has(path)) read.delete(path)
    return found
}

/** Whether `db` is a new orrery's: no projects, and no owner named yet. */
export async function isFresh(db: Db): Promise<boolean> {
    const projects = await db.get<{n: number}>('SELECT count(*) AS n FROM projects')
    if (Number(projects?.n ?? 0)) return false
    return !await db.get('SELECT 1 AS found FROM people WHERE role = \'owner\'')
}

/** Keeps the name this orrery runs under in its own settings, so its backups say which orrery they're a copy of. */
export async function noteEnvironment(db: Db, environment: string) {
    await db.run('INSERT INTO settings (key, value) VALUES (\'environment\', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', JSON.stringify(environment))
}

/** A time for a file name: `2026-10-28T19-30-05`. */
const stamp = () => new Date().toISOString().slice(0, 19).replace(/:/g, '-')

/** Makes the database to restore `name` from `dir` into: checked whole first (`integrity_check`), then copied beside
 * `live` (the file orrery runs on) under a name of its own, and only then given that name. Says where it is. */
export function restoredCopy(dir: string, name: string, live: string): string {
    if (!kindOf(name) || name.includes('/') || name.includes('\\')) throw new Error(`${name} isn't one of the backups`)
    const from = join(dir, name)
    if (!existsSync(from)) throw new Error(`${name} isn't in ${dir}`)
    checkSnapshot(from, true)
    const to = join(dirname(live), `orrery-restored-${stamp()}.db`)
    mkdirSync(dirname(to), {recursive: true})
    copyFileSync(from, `${to}.partial`)
    renameSync(`${to}.partial`, to)
    return to
}

/** Copies the database orrery runs on into the backup folder as it is, before a restore takes its place. */
export async function keepBeforeRestore(database: Db, dir: string): Promise<string> {
    const name = `orrery-pre-restore-${stamp()}.db`
    const temporary = join(dir, `.${name}.partial`)
    if (!(database instanceof SqliteDb)) throw new Error('Only a SQLite orrery is restored from the app')
    await database.alone(raw => raw.prepare('VACUUM INTO ?').run(temporary))
    checkSnapshot(temporary)
    renameSync(temporary, join(dir, name))
    return name
}
