// `GET /api/projects/:project/schedules/:schedule` → the schedule, with its latest runs.
export default defineEventHandler(event => useScheduler().get(param(event, 'project'), scheduleId(event)))
