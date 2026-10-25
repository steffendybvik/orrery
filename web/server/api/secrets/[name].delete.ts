// `DELETE /api/secrets/:name` → 204: the owner's only. Its uses stay on record.
export default defineEventHandler(async event => {
    await useSecrets().delete(param(event, 'name'), await actorOf(event))
    return deleted(event)
})
