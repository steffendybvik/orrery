import type {NoticeList} from '#shared/roadmap'

// `GET /api/notices` → agents' latest comments across projects (the page's bell). `?list=` gives the
// notifications page's: `waiting` (all), `inbox` and `cleared` a page at a time (`?before=<id>&limit=`).
export default defineEventHandler(async event => {
    const {list, before, limit} = getQuery(event)
    return useStore().notices({
        list: list === undefined ? undefined : String(list) as NoticeList,
        before: before === undefined ? undefined : Number(before) || undefined,
        limit: limit === undefined ? undefined : Number(limit) || undefined,
    })
})
