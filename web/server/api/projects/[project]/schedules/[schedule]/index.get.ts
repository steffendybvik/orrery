// `GET /api/projects/:project/schedules/:schedule` → the schedule, with its latest runs.
export default defineEventHandler(async event => useScheduler().get(param(event, 'project'), await scheduleId(event)))
