// `POST /api/projects/:project/schedules/:schedule/run` → the run: makes its issue now (and asks the
// sessions, if it does), even while the last run's issue is open.
export default defineEventHandler(event => created(event, useSchedules().runNow(param(event, 'project'), scheduleId(event))))
