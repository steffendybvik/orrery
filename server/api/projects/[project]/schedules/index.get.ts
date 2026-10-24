// `GET /api/projects/:project/schedules` → the project's schedules, soonest first, paused last.
export default defineEventHandler(event => useSchedules().list(param(event, 'project')))
