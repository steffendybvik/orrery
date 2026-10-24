// `POST /api/projects/:project/schedules` {title, notes?, cron | at, timezone?, column?, chunk?, priority?,
// labels?, ask?, skipOpen?, enabled?} → the schedule, with its next run worked out.
export default defineEventHandler(async event => created(event, useSchedules().create(param(event, 'project'), await readBody(event), actorOf(event))))
