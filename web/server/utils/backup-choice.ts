// Whether the database is backed up, and to which folder: NUXT_BACKUP_DIR (ORRERY_BACKUP's `/backup` in Docker),
// unless the owner chose otherwise in App settings. Their choice is kept beside the SQLite file NUXT_DATABASE names
// (`orrery.db.backups.json`), next to a move's; there's none when NUXT_DATABASE is Postgres, which is set as orrery
// starts, and so are its backups.
import {existsSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {dirname, isAbsolute, resolve} from 'node:path'
import type {H3Event} from 'h3'
import {actorOf} from './actor'
import {backUp} from './backup'
import {databaseSetting, useDatabase} from './db'
import {badRequest, conflict, forbidden} from './input'
import {fromThisMachine} from './move'
import {isPostgres} from './postgres'

/** `on` false: no backups. `folder`: where they go instead of NUXT_BACKUP_DIR. */
export interface BackupChoice {
    on: boolean
    folder?: string
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
    if (choice.on && !folder) {
        rmSync(file, {force: true})
        chosen = null
    } else {
        chosen = {on: choice.on, ...folder ? {folder} : {}}
        writeFileSync(file, `${JSON.stringify({...chosen, chosen_at: new Date().toISOString()}, null, 2)}\n`)
    }
}

/** Only the owner sets the backups, and only on this machine: a folder chosen is where the data goes. */
export async function maySetBackups(event: H3Event) {
    const actor = await actorOf(event)
    if (!actor.owner) throw forbidden('Only the owner sets the backups; send Orrery-Actor: <owner>')
    if (!fromThisMachine(event)) throw forbidden('The backups are set from the machine orrery runs on: open it at localhost')
    if (!backupChoiceFile()) throw conflict('ORRERY_DATABASE (NUXT_DATABASE) names Postgres, so the backups are set as orrery starts: ORRERY_BACKUP (NUXT_BACKUP_DIR)')
}

/** `{on, folder?}` from App settings: turned on, it's backed up there at once, and the choice is kept only once that
 * worked. `folder` (a full path) is where instead of NUXT_BACKUP_DIR; none goes back to it. */
export async function chooseBackups(body: unknown) {
    const {on, folder} = (body ?? {}) as {on?: unknown, folder?: unknown}
    if (typeof on !== 'boolean') throw badRequest('"on" is true or false')
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
            await backUp(useDatabase(), dir)
        } catch (error) {
            throw badRequest(`Can't back up to ${dir}: ${(error as Error).message}`)
        }
    }
    saveBackupChoice({on, ...chosen ? {folder: chosen} : {}})
}
