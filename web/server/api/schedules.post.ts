// `POST /api/schedules` {projects: '*' | [ids], skip?, …a schedule's fields} → the schedule across projects, made on each.
export default defineEventHandler(async event => created(event, await useScheduler().createAcross(await readBody(event), await actorOf(event))))
