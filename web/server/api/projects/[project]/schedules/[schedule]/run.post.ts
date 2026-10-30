// `POST /api/projects/:project/schedules/:schedule/run` → the run: makes its issue now (and asks the
// sessions, if it does), even while the last run's issue is open. `{"instead": true}` runs it in place of its
// next run, which is skipped.
export default defineEventHandler(async event => {
    const body = await readBody<{instead?: unknown} | undefined>(event)
    return created(event, await useScheduler().runNow(param(event, 'project'), await scheduleId(event), await actorOf(event), body?.instead === true))
})
