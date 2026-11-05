// `PATCH /api/epics/:epic` {title?, notes?, position?} → the epic; `position` moves it among them (0 the top).
export default defineEventHandler(async event => await useStore().updateEpic(epicId(event), await readBody(event), await actorOf(event)))
