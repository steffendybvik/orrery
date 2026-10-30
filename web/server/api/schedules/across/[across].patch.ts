// `PATCH /api/schedules/across/:across` {projects?, skip?, …a schedule's fields} → it, changed along with the schedules made from it.
export default defineEventHandler(async event => useScheduler().updateAcross(Number(param(event, 'across')), await readBody(event), await actorOf(event)))
