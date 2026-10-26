// `POST /api/projects/:project/schedules` {title, notes?, cron | at, timezone?, column?, chunk?, priority?,
// labels?, ask?, skip_open?, enabled?} → the schedule, with its next run worked out.
export default defineEventHandler(async event => created(event, await useScheduler().create(param(event, 'project'), await readBody(event), await actorOf(event))))
