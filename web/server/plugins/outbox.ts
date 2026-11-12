// Follows the Rust API's outbox (ORR-983) while this server fronts the API: NUXT_API_BIN or NUXT_API_URL set, or under
// `nuxt dev` the repo's own build, as plugins/api.ts starts it (`apiBinary`), so the dev server and the browser suite hear
// the API's writes as the image does (ORR-1088). With none, it does nothing, and this server hears its own writes from the store's hooks as ever. Its cursor is kept
// beside the database (outbox-follower.ts), so a restart carries on from where it was; the first start begins at the
// newest row, as there's nothing it missed, which the API says (`after=newest`, ORR-1136). When the owner moves the database it follows the new one's outbox, with
// that one's cursor (ORR-1035).
import {apiBinary} from '../utils/api-migrate'
import {apiTarget, databaseMark} from '../utils/api-router'
import {cursorFile, followOutbox, readCursor, readPage, saveCursor, setFollowingOutbox} from '../utils/outbox-follower'

export default defineNitroPlugin(nitro => {
    const config = useRuntimeConfig()
    if (!apiBinary() && !config.apiUrl) return
    let closed = false
    /** Which run follows now: a move starts another, and the one before stops at its next page. */
    let runs = 0
    let running: Promise<void> = Promise.resolve()
    const run = async (mine: number) => {
        const store = useStore()
        const database = databaseSetting()
        const file = cursorFile(database)
        const after = readCursor(file, database) ?? 'newest'
        if (closed || mine !== runs) return
        store.keepOwnChanges()
        setFollowingOutbox(true)
        await followOutbox(store, {
            // Until the API is listening there's nothing to read, and the router answers its routes here.
            read: async from => {
                const api = apiTarget(config)
                if (!api) return null
                return await readPage(api, databaseMark(database), from)
            },
            after,
            saved: last => saveCursor(file, database, last),
            stopped: () => closed || mine !== runs,
        })
    }
    const follow = () => {
        const mine = ++runs
        running = running.then(() => run(mine)).catch(error => {
            if (mine !== runs) return
            setFollowingOutbox(false)
            console.error("[orrery] stopped following the Rust API's outbox:", error)
        })
    }
    follow()
    projectEvents.on('database', follow)
    nitro.hooks.hook('close', () => {
        closed = true
        projectEvents.off('database', follow)
        setFollowingOutbox(false)
    })
})
