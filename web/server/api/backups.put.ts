// `PUT /api/backups {on, folder?}` → `database` as `GET /api/settings` has it: the owner's choice of whether the
// database is backed up and where, from App settings (see server/utils/backup-choice.ts). The owner's, from localhost;
// 409 when NUXT_DATABASE names Postgres, for a folder in Docker (ORRERY_BACKUP sets it), or on with nowhere to go.
export default defineEventHandler(async event => {
    await maySetBackups(event)
    const body = await readBody(event)
    await chooseBackups(body)
    const database = describeDatabase()
    useEventLog().note({level: 'info', kind: 'backup.set', message: database.backup ? `Backing up to ${database.backup}` : 'Turned backups off'})
    return {...database, ...await databaseSize(database, useDatabase())}
})
