// `POST /api/projects/:project/schedules/:schedule/run` → the run: makes its issue now (and asks the
// sessions, if it does), even while the last run's issue is open.
export default defineEventHandler(async event => created(event, await useScheduler().runNow(param(event, 'project'), scheduleId(event))))
