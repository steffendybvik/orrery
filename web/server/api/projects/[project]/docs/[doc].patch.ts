// `PATCH /api/projects/:project/docs/:doc` {title?, body?, position?} → the doc.
export default defineEventHandler(async event => useStore().updateDoc(param(event, 'project'), param(event, 'doc'), await readBody(event), await actorOf(event)))
