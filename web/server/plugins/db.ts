// The database as the server starts and stops. On start, this orrery's id is made if it hasn't been asked for yet, and
// a Docker orrery that starts empty says where its data may be. As the server stops it closes the database, so a
// reloaded server in `nuxt dev` can open it straight away.
import {ORRERY as ORRERY_ACTOR} from '../store/schema'
import {inDocker} from '../utils/host-paths'

export default defineNitroPlugin(nitro => {
    const log = useEventLog()
    starting().catch(error => console.error('[orrery] checking the database on start:', error))
    async function starting() {
        // The API's settings make the id as the store's do.
        if (!await writeToApi('GET', '/api/settings', undefined, ORRERY_ACTOR, {always: true})) await useStore().settings()
        if (!inDocker() || !await databaseFresh()) return
        const message = 'This orrery\'s database is empty. If it had data before, it may be in another Docker volume (a folder with another name gives another one): see `docker volume ls`'
        console.warn(`[orrery] ${message}`)
        log.note({level: 'warn', kind: 'database.empty', message})
    }
    nitro.hooks.hook('close', () => closeDb())
})
