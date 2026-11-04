// `POST /api/backups` → `database` as `GET /api/settings` has it, once the database is backed up: the owner's
// Back up now, as each change does a few seconds after. 409 when backups are off, or there's no folder for them.
import {countOwnUse} from '../utils/usage'

export default defineEventHandler(async event => {
    countOwnUse(event, 'backup-now')
    await authorize(event, 'database.write')
    const target = backupTarget()
    if (!target) throw conflict('orrery isn\'t backed up: turn backups on in App settings → Database, or set ORRERY_BACKUP (NUXT_BACKUP_DIR outside Docker)')
    const db = useDatabase()
    await backUpTo(db, target, backupKeep()).catch((error: Error) => {
        throw conflict(`Backing up to ${targetLabel(target)}: ${error.message}`)
    })
    const database = describeDatabase()
    return {...database, ...await databaseSize(database, db)}
})
