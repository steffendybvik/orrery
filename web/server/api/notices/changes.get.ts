// `GET /api/notices/changes?since=<time>` → status changes since then on the issues in the asker's bell, oldest first:
// what the notifications page says happened to them.
export default defineEventHandler(async event => {
    const {since} = getQuery(event)
    return useStore().noticeChanges({since: since === undefined ? undefined : String(since), person: await personOf(event)})
})
