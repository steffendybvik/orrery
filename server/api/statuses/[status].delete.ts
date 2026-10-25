// `DELETE /api/statuses/:status?into=<status>` → 204: the owner's only. Its issues and schedules move to
// `into`, which it needs while it has any; the last status of a kind stays.
export default defineEventHandler(event => {
    const into = getQuery(event).into
    useStore().deleteStatus(param(event, 'status'), typeof into === 'string' && into ? into : undefined, actorOf(event))
    setResponseStatus(event, 204)
    return null
})
