// `DELETE /api/projects/:project/schedules/:schedule`: the issues it made stay.
export default defineEventHandler(async event => {
    await useScheduler().delete(param(event, 'project'), scheduleId(event), await actorOf(event))
    return deleted(event)
})
