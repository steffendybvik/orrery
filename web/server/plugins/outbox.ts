// Follows the Rust API's outbox (ORR-983) while this server fronts the API: NUXT_API_BIN or NUXT_API_URL set. With
// neither, it does nothing, and this server hears its own writes from the store's hooks as ever. Its cursor is kept
// beside the database (outbox-follower.ts), so a restart carries on from where it was; the first start begins at the
// newest row, as there's nothing it missed.
import {apiTarget, databaseMark} from '../utils/api-router'
import {cursorFile, followOutbox, readCursor, readPage, saveCursor, setFollowingOutbox} from '../utils/outbox-follower'

export default defineNitroPlugin(nitro => {
    const config = useRuntimeConfig()
    if (!config.apiBin && !config.apiUrl) return
    let stopped = false
    nitro.hooks.hook('close', () => {
        stopped = true
        setFollowingOutbox(false)
    })
    const run = async () => {
        const store = useStore()
        const database = databaseSetting()
        const file = cursorFile(database)
        const newest = async () => Number((await store.db.get<{n: number | string | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0)
        const after = readCursor(file, database) ?? await newest()
        store.keepOwnChanges()
        setFollowingOutbox(true)
        await followOutbox(store, {
            // Until the API is listening there's nothing to read, and the router answers its routes here.
            read: async from => {
                const api = apiTarget(config)
                if (!api) return {changes: [], last: from}
                return await readPage(api, databaseMark(database), from)
            },
            after,
            saved: last => saveCursor(file, database, last),
            stopped: () => stopped,
        })
    }
    run().catch(error => {
        setFollowingOutbox(false)
        console.error("[orrery] stopped following the Rust API's outbox:", error)
    })
})
