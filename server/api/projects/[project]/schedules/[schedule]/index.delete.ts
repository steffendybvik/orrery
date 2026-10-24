// `DELETE /api/projects/:project/schedules/:schedule`: the issues it made stay.
export default defineEventHandler(event => {
    useScheduler().delete(param(event, 'project'), scheduleId(event), actorOf(event))
    return deleted(event)
})
