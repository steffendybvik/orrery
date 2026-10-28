// Whether the database is backed up, and where: a folder, NUXT_BACKUP_DIR (ORRERY_BACKUP's `/backup` in Docker), or a
// Postgres database, NUXT_BACKUP_DATABASE (ORRERY_BACKUP_DATABASE), which takes the place of the folder when it's set
// (ORR-427); unless the owner chose otherwise in App settings. Their choice is kept beside the SQLite file NUXT_DATABASE
// names (`orrery.db.backups.json`, readable by its owner alone, as it can hold a Postgres password), next to a move's;
// there's none when NUXT_DATABASE is Postgres, which is set as orrery starts, and so are its backups.
import {chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, resolve} from 'node:path'
import type {H3Event} from 'h3'
import {actorOf} from './actor'
import type {BackupTarget} from './backup'
import {backUpTo, closeBackupDb} from './backup'
import {databaseSetting, hidePassword, useDatabase} from './db'
import {badRequest, conflict, forbidden} from './input'
import {fromThisMachine, notThisMachine} from './move'
import {isPostgres} from './postgres'

/** `on` false: no backups. `folder`: where they go instead of NUXT_BACKUP_DIR; `postgres`: the URL of a Postgres
 * database they go into instead. */
export interface BackupChoice {
    on: boolean
    folder?: string
    postgres?: string
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

/** The Postgres database orrery is given for its backups as it starts (NUXT_BACKUP_DATABASE), if any. */
export function defaultBackupDatabase(): string {
    const url = String(useRuntimeConfig().backupDatabase ?? '').trim()
    return isPostgres(url) ? url : ''
}

/** Where the database is backed up to now; none when it isn't. */
export function backupTarget(): BackupTarget | null {
    const choice = backupChoice()
    if (choice && !choice.on) return null
    if (choice?.postgres) return {kind: 'postgres', url: choice.postgres}
    if (choice?.folder) return {kind: 'folder', dir: choice.folder}
    if (defaultBackupDatabase()) return {kind: 'postgres', url: defaultBackupDatabase()}
    return defaultBackupDir() ? {kind: 'folder', dir: defaultBackupDir()} : null
}

/** The folder the database is backed up to now; empty when it isn't backed up to one. */
export function backupDir(): string {
    const target = backupTarget()
    return target?.kind === 'folder' ? target.dir : ''
}

/** In orrery's image the backups go to the mounted `/backup` (a host folder by ORRERY_BACKUP): a folder chosen inside
 * the container would go with it. The image says so (ORRERY_IMAGE); any container has a `/.dockerenv`, CI's
 * Playwright one running orrery from source too. */
export function inDocker(): boolean {
    return process.env.ORRERY_IMAGE === '1'
}

/** Saves the owner's choice; backups on in NUXT_BACKUP_DIR, as orrery starts without one, forgets it. */
export function saveBackupChoice(choice: BackupChoice) {
    const file = backupChoiceFile()
    if (!file) throw new Error('NUXT_DATABASE names Postgres: set the backups where it\'s set')
    const folder = choice.folder && choice.folder !== defaultBackupDir() ? choice.folder : undefined
    const postgres = choice.postgres && choice.postgres !== defaultBackupDatabase() ? choice.postgres : undefined
    if (choice.on && !folder && !postgres) {
        rmSync(file, {force: true})
        chosen = null
    } else {
        chosen = {on: choice.on, ...folder ? {folder} : {}, ...postgres ? {postgres} : {}}
        writeFileSync(file, `${JSON.stringify({...chosen, chosen_at: new Date().toISOString()}, null, 2)}\n`, {mode: 0o600})
        chmodSync(file, 0o600)
    }
}

/** Only the owner sets the backups, and only on this machine: a folder chosen is where the data goes. */
export async function maySetBackups(event: H3Event) {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner sets the backups; send Orrery-Actor: <owner>')
    if (!fromThisMachine(event)) throw forbidden(notThisMachine('The backups are set'))
    if (!backupChoiceFile()) throw conflict('ORRERY_DATABASE (NUXT_DATABASE) names Postgres, so the backups are set as orrery starts: ORRERY_BACKUP (NUXT_BACKUP_DIR)')
}

/** `{on, folder?}` or `{on, postgres}` from App settings: turned on, it's backed up there at once, and the choice is
 * kept only once that worked. `folder` (a full path) is where instead of NUXT_BACKUP_DIR; `postgres` a Postgres
 * database's URL, empty or this orrery's backup already; neither goes back to what orrery was given as it started. */
export async function chooseBackups(body: unknown) {
    const {on, folder, postgres} = (body ?? {}) as {on?: unknown, folder?: unknown, postgres?: unknown}
    if (typeof on !== 'boolean') throw badRequest('"on" is true or false')
    // Turned off or on alone, backups into Postgres stay there: the page doesn't know the password to send again.
    const kept = backupChoice()?.postgres
    if (folder === undefined && postgres === undefined && kept) return choosePostgres(on, kept)
    if (postgres !== undefined && postgres !== null) {
        if (folder !== undefined && folder !== null) throw badRequest('Back up to a folder or to Postgres, not both')
        return choosePostgres(on, postgres)
    }
    if (folder !== undefined && folder !== null && (typeof folder !== 'string' || !isAbsolute(folder.trim()))) throw badRequest('"folder" is a full path, such as /Users/you/Backups/orrery')
    const chosen = typeof folder === 'string' ? resolve(folder.trim()) : undefined
    if (chosen && chosen !== defaultBackupDir() && inDocker()) throw conflict('In Docker the backups go to /backup: choose its folder on this machine with ORRERY_BACKUP and restart orrery')
    const dir = chosen ?? defaultBackupDir()
    if (on) {
        if (!dir) throw conflict('Give orrery a folder for its backups')
        if (existsSync(dir) && !statSync(dir).isDirectory()) throw badRequest(`${dir} is a file: name a folder`)
        const live = databaseSetting()
        // A backup is written as `orrery.db`, so the database's own folder would have it written over.
        if ([dirname(resolve(String(useRuntimeConfig().database))), ...isPostgres(live) ? [] : [dirname(live)]].includes(dir)) throw badRequest(`${dir} is where the database is: keep its backups somewhere else`)
        try {
            await backUpTo(useDatabase(), {kind: 'folder', dir})
        } catch (error) {
            throw badRequest(`Can't back up to ${dir}: ${(error as Error).message}`)
        }
    }
    saveBackupChoice({on, ...chosen ? {folder: chosen} : {}})
    await closeBackupDb()
}

/** Backups into the Postgres database at `url`: checked by backing up into it at once, when they're turned on. */
async function choosePostgres(on: boolean, postgres: unknown) {
    if (typeof postgres !== 'string' || !isPostgres(postgres.trim())) throw badRequest('"postgres" is a Postgres URL: postgres://user:password@host:5432/name')
    const url = postgres.trim()
    try {
        new URL(url)
    } catch {
        throw badRequest('That Postgres URL doesn\'t read as one: postgres://user:password@host:5432/name')
    }
    if (url === databaseSetting()) throw badRequest('That\'s the database orrery runs on: back up somewhere else')
    if (on) {
        try {
            await backUpTo(useDatabase(), {kind: 'postgres', url})
        } catch (error) {
            await closeBackupDb()
            throw badRequest(`Can't back up to ${hidePassword(url)}: ${(error as Error).message}`)
        }
    }
    saveBackupChoice({on, postgres: url})
}
