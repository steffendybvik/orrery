// `GET /api/projects/:project/schedules` → the project's schedules, soonest first, paused last.
export default defineEventHandler(async event => useScheduler().list(param(event, 'project')))
