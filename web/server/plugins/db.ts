// The database as the server starts and stops. On start, this orrery's id is made if it hasn't been asked for yet; an
// empty one says nothing, as a new install is empty too (where lost data may be is lost-data.ts's, ORR-1180). As the
// server stops it closes the database, so a reloaded server in `nuxt dev` can open it straight away.
import {ORRERY as ORRERY_ACTOR} from '../store/schema'

export default defineNitroPlugin(nitro => {
    starting().catch(error => console.error('[orrery] checking the database on start:', error))
    async function starting() {
        // The API's settings make the id as the store's do.
        if (!await writeToApi('GET', '/api/settings', undefined, ORRERY_ACTOR, {always: true})) await useStore().settings()
    }
    nitro.hooks.hook('close', () => closeDb())
})
