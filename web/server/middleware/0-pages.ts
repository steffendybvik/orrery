// An API-only server (ORR-667): with NUXT_PAGES=off (ORRERY_PAGES in compose), orrery answers its API and what the
// machines running sessions fetch (the channel, hooks and launcher under /channel and /connect, /llms*, /healthz), and
// serves none of its pages. That's for a frontend built on its own and hosted elsewhere (docs/running.md, Hosting the
// page on its own). It's the same server and image, with nothing else changed. Unset, every page is served as before.
import {pathOf} from '../utils/auth'

const KEPT = /^\/(api|channel|connect)(\/|$)|^\/(healthz|llms\.txt|llms-full\.txt)$/

const pagesOff = () => String(useRuntimeConfig().pages ?? '').toLowerCase() === 'off'

export default defineEventHandler(event => {
    if (!pagesOff() || KEPT.test(pathOf(event))) return
    throw createError({statusCode: 404, statusMessage: 'Not Found', message: 'This orrery serves its API only (NUXT_PAGES=off): open its page where it is hosted'})
})
