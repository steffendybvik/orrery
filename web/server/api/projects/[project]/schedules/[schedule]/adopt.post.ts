// `POST /api/projects/:project/schedules/:schedule/adopt` {seen?} → the schedule: the owner making an agent's schedule
// theirs ("Make it mine", ORR-456), after reading its notes and presets. `seen` is the `updated_at` they read it at; one
// changed since is a 409. Only the owner (403 for an agent); one already theirs comes back as it is.
export default defineEventHandler(async event => {
    const body = await readBody<{seen?: unknown} | undefined>(event).catch(() => undefined)
    if (body?.seen !== undefined && typeof body.seen !== 'string') throw badRequest('"seen" is the updated_at you read the schedule at')
    return await useScheduler().adopt(param(event, 'project'), scheduleId(event), await actorOf(event), body?.seen as string | undefined)
})
