// `POST /api/epics` {title, notes?, position?} → 201 the new epic, on top unless `position` says where. An issue joins it
// with `epic` (its number) on the issue.
export default defineEventHandler(async event => created(event, await useStore().createEpic(await readBody(event), await actorOf(event))))
