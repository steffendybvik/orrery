// `POST /api/backups/restore` `{name}` → `database` as `GET /api/settings` has it, once orrery runs on a copy of that
// backup (ORR-448). The copy is checked whole first, and the database as it was goes in the backup folder
// (`orrery-pre-restore-<time>.db`) before orrery switches, as a move does, without a restart; the file it ran on stays
// as it was. The owner's, from localhost, on a SQLite orrery; on a new one (no projects, no owner) anyone on this
// machine, as its first page asks. 409 when it can't be restored.
export default defineEventHandler(async event => {
    const fresh = await isFresh(useDatabase())
    if (!fresh) await mayMove(event)
    else if (!fromThisMachine(event)) throw forbidden(notThisMachine('A backup is restored'))
    if (!movedFile()) throw conflict('ORRERY_DATABASE (NUXT_DATABASE) names Postgres, so the database is set there: restore into it with Postgres\'s own tools')
    if (isPostgres(databaseSetting())) throw conflict('orrery runs on Postgres: move it to a SQLite file first, or restore with Postgres\'s own tools')
    const dir = backupTarget()?.kind === 'folder' ? backupDir() : ''
    if (!dir) throw conflict('orrery has no backup folder to restore from')
    const {name} = (await readBody<{name?: unknown}>(event)) ?? {}
    if (typeof name !== 'string' || !name) throw badRequest('"name" is the backup to restore, as GET /api/backups lists it')
    const snapshot = listSnapshots(dir).find(s => s.name === name)
    if (!snapshot) throw badRequest(`${name} isn't one of the backups in ${dir}`)
    const before = describeDatabase()
    const kept = await keepBeforeRestore(useDatabase(), dir).catch((error: Error) => {
        throw conflict(`orrery won't restore without a copy of the database as it is, and couldn't make one: ${error.message}`)
    })
    let copy: string
    try {
        copy = restoredCopy(dir, name, before.where)
    } catch (error) {
        throw conflict(`Restoring ${name}: ${(error as Error).message}`)
    }
    await moveDatabase(copy, 'use', rebindDatabase)
    const database = describeDatabase()
    useEventLog().note({level: 'info', kind: 'database.restored', message: `Restored ${name} (from ${snapshot.at}) into ${database.where}; the database as it was is in ${kept}`,
        details: {name, at: snapshot.at, kept, from: before.where, ...snapshot.of ? {of: snapshot.of} : {}, ...snapshot.environment ? {environment: snapshot.environment} : {}}})
    return {database: {...database, ...await databaseSize(database, useDatabase())}}
})
