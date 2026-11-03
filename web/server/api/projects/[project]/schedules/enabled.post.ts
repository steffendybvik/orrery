// `POST /api/projects/:project/schedules/enabled` {enabled} → {changed, failed}: pauses or activates all of the project's
// schedules, as the owner alone. A paused one-off isn't activated, as it may have run, and one that fails doesn't stop the rest.
export default defineEventHandler(async event => {
    const {enabled} = (await readBody(event) ?? {}) as {enabled?: unknown}
    if (typeof enabled !== 'boolean') throw badRequest('Send {"enabled": true} or {"enabled": false}')
    return await useScheduler().setAllEnabled(param(event, 'project'), enabled, await actorOf(event))
})
