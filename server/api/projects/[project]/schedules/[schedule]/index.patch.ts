// `PATCH /api/projects/:project/schedules/:schedule` {any of the fields} → the schedule; `enabled: false` pauses it.
export default defineEventHandler(async event => useSchedules().update(param(event, 'project'), scheduleId(event), await readBody(event)))
