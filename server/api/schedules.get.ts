// `GET /api/schedules` → every project's schedules (the agenda), soonest first, paused last.
export default defineEventHandler(() => useScheduler().list())
