// `PATCH /api/projects/:project/schedules/:schedule` {any of the fields} → the schedule; `enabled: false` pauses it.
export default defineEventHandler(async event => useScheduler().update(param(event, 'project'), scheduleId(event), await readBody(event), await actorOf(event)))
