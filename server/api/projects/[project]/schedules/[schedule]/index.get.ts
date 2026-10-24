// `GET /api/projects/:project/schedules/:schedule` → the schedule, with its latest runs.
export default defineEventHandler(event => useSchedules().get(param(event, 'project'), scheduleId(event)))
