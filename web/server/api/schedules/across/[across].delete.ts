// `DELETE /api/schedules/across/:across` → 204: it and the schedules made from it; their issues stay.
export default defineEventHandler(async event => {
    await useScheduler().deleteAcross(Number(param(event, 'across')), await actorOf(event))
    setResponseStatus(event, 204)
    return null
})
