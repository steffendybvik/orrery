// Whether the database is backed up, to which folder, how often and how many daily copies stay: NUXT_BACKUP_DIR (ORRERY_BACKUP's `/backup` in Docker),
// unless the owner chose otherwise in App settings. Their choice is kept beside the SQLite file NUXT_DATABASE names
// (`orrery.db.backups.json`), next to a move's; there's none when NUXT_DATABASE is Postgres, which is set as orrery
// starts, and so are its backups.
import {existsSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, resolve} from 'node:path'
import type {H3Event} from 'h3'
import {actorOf} from './actor'
import type {BackupEvery} from './backup'
import {BACKUP_EVERY, KEEP_DAYS, MAX_KEEP_DAYS, backUp} from './backup'
import {databaseSetting, useDatabase} from './db'
import {badRequest, conflict, forbidden} from './input'
import {fromThisMachine, notThisMachine} from './move'
import {isPostgres} from './postgres'

/** `on` false: no backups. `folder`: where they go instead of NUXT_BACKUP_DIR. `every`: how often, when not a few
 * seconds after each change. `keep`: how many daily copies stay, when not KEEP_DAYS. */
export interface BackupChoice {
    on: boolean
    folder?: string
    every?: BackupEvery
    keep?: number
}

/** Where the owner's choice is kept; none when NUXT_DATABASE is Postgres. */
export function backupChoiceFile(): string | null {
    const setting = String(useRuntimeConfig().database)
    return isPostgres(setting) ? null : `${resolve(setting)}.backups.json`
}

let chosen: BackupChoice | null | undefined

/** The owner's choice, if they made one. */
export function backupChoice(): BackupChoice | null {
    if (chosen === undefined) {
        const file = backupChoiceFile()
        chosen = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as BackupChoice : null
    }
    return chosen
}

/** The folder orrery sets for its backups as it starts (NUXT_BACKUP_DIR), if any. */
export function defaultBackupDir(): string {
    const dir = String(useRuntimeConfig().backupDir ?? '')
    return dir && resolve(dir)
}

/** Where the database is backed up to now; empty when it isn't. */
export function backupDir(): string {
    const choice = backupChoice()
    if (choice && !choice.on) return ''
    return choice?.folder ?? defaultBackupDir()
}

/** How often it backs up: after each change unless the owner chose otherwise. */
export function backupEvery(): BackupEvery {
    return backupChoice()?.every ?? 'change'
}

/** How many daily copies stay. */
export function backupKeep(): number {
    return backupChoice()?.keep ?? KEEP_DAYS
}

/** In orrery's image the backups go to the mounted `/backup` (a host folder by ORRERY_BACKUP): a folder chosen inside
 * the container would go with it. The image says so (ORRERY_IMAGE); any container has a `/.dockerenv`, CI's
 * Playwright one running orrery from source too. */
export function inDocker(): boolean {
    return process.env.ORRERY_IMAGE === '1'
}

/** Saves the owner's choice; backups on in NUXT_BACKUP_DIR after each change keeping KEEP_DAYS, as orrery starts
 * without one, forgets it. */
export function saveBackupChoice(choice: BackupChoice) {
    const file = backupChoiceFile()
    if (!file) throw new Error('NUXT_DATABASE names Postgres: set the backups where it\'s set')
    const folder = choice.folder && choice.folder !== defaultBackupDir() ? choice.folder : undefined
    const every = choice.every && choice.every !== 'change' ? choice.every : undefined
    const keep = choice.keep !== undefined && choice.keep !== KEEP_DAYS ? choice.keep : undefined
    if (choice.on && !folder && !every && keep === undefined) {
        rmSync(file, {force: true})
        chosen = null
    } else {
        chosen = {on: choice.on, ...folder ? {folder} : {}, ...every ? {every} : {}, ...keep !== undefined ? {keep} : {}}
        writeFileSync(file, `${JSON.stringify({...chosen, chosen_at: new Date().toISOString()}, null, 2)}\n`)
    }
}

/** Only the owner sets the backups, and only on this machine: a folder chosen is where the data goes. */
export async function maySetBackups(event: H3Event) {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner sets the backups; send Orrery-Actor: <owner>')
    if (!fromThisMachine(event)) throw forbidden(notThisMachine('The backups are set'))
    if (!backupChoiceFile()) throw conflict('ORRERY_DATABASE (NUXT_DATABASE) names Postgres, so the backups are set as orrery starts: ORRERY_BACKUP (NUXT_BACKUP_DIR)')
}

/** `{on?, folder?, every?, keep?}` from App settings. `on` (with `folder`, a full path, where instead of NUXT_BACKUP_DIR;
 * none goes back to it): turned on, it's backed up there at once, and the choice is kept only once that worked. `every`
 * (`change`, `15m`, `hour`, `day`) and `keep` (daily copies, 1–365) change only how often and how many, as they are
 * otherwise. */
export async function chooseBackups(body: unknown) {
    const {on, folder, every, keep} = (body ?? {}) as {on?: unknown, folder?: unknown, every?: unknown, keep?: unknown}
    if (on === undefined && every === undefined && keep === undefined) throw badRequest('Send "on" (with "folder" if you like), "every" or "keep"')
    if ((on !== undefined || folder !== undefined) && typeof on !== 'boolean') throw badRequest('"on" is true or false')
    if (folder !== undefined && folder !== null && (typeof folder !== 'string' || !isAbsolute(folder.trim()))) throw badRequest('"folder" is a full path, such as /Users/you/Backups/orrery')
    if (every !== undefined && !BACKUP_EVERY.includes(every as BackupEvery)) throw badRequest(`"every" is one of ${BACKUP_EVERY.join(', ')}`)
    if (keep !== undefined && (!Number.isInteger(keep) || (keep as number) < 1 || (keep as number) > MAX_KEEP_DAYS)) throw badRequest(`"keep" is a whole number of daily copies, 1 to ${MAX_KEEP_DAYS}`)
    const now = backupChoice()
    const how = {every: (every as BackupEvery | undefined) ?? now?.every, keep: (keep as number | undefined) ?? now?.keep}
    if (on === undefined) return saveBackupChoice({on: now?.on ?? true, ...now?.folder ? {folder: now.folder} : {}, ...how})
    const chosen = typeof folder === 'string' ? resolve(folder.trim()) : folder === undefined ? now?.folder : undefined
    const turnOn = (on as boolean | undefined) ?? now?.on ?? true
    if (chosen && chosen !== defaultBackupDir() && inDocker()) throw conflict('In Docker the backups go to /backup: choose its folder on this machine with ORRERY_BACKUP and restart orrery')
    const dir = chosen ?? defaultBackupDir()
    if (turnOn) {
        if (!dir) throw conflict('Give orrery a folder for its backups')
        if (existsSync(dir) && !statSync(dir).isDirectory()) throw badRequest(`${dir} is a file: name a folder`)
        const live = databaseSetting()
        // A backup is written as `orrery.db`, so the database's own folder would have it written over.
        if ([dirname(resolve(String(useRuntimeConfig().database))), ...isPostgres(live) ? [] : [dirname(live)]].includes(dir)) throw badRequest(`${dir} is where the database is: keep its backups somewhere else`)
        try {
            await backUp(useDatabase(), dir, how.keep ?? KEEP_DAYS)
        } catch (error) {
            throw badRequest(`Can't back up to ${dir}: ${(error as Error).message}`)
        }
    }
    saveBackupChoice({on: turnOn, ...chosen ? {folder: chosen} : {}, ...how})
}
