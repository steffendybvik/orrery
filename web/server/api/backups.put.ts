// `PUT /api/backups {on?, folder?, every?, keep?}` → `database` as `GET /api/settings` has it: the owner's choice of
// whether the database is backed up, where, how often and how many daily copies stay, from App settings (see
// server/utils/backup-choice.ts). The owner's, from localhost;
// 409 when NUXT_DATABASE names Postgres, for a folder in Docker (ORRERY_BACKUP sets it), or on with nowhere to go.
const EVERY_SAID = {change: 'after each change', '15m': 'every 15 minutes', hour: 'every hour', day: 'every day'}

export default defineEventHandler(async event => {
    await maySetBackups(event)
    const body = await readBody(event)
    await chooseBackups(body)
    const database = describeDatabase()
    useEventLog().note({level: 'info', kind: 'backup.set', message: database.backup
        ? `Backing up to ${database.backup}, ${EVERY_SAID[database.backup_every ?? 'change']}, keeping ${database.backup_keep} daily copies`
        : 'Turned backups off'})
    return {...database, ...await databaseSize(database, useDatabase())}
})
