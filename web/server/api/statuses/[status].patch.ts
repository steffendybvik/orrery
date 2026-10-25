// `PATCH /api/statuses/:status` {name?, kind?, color?, position?} → the status: the owner's only. Its id stays.
export default defineEventHandler(async event => useStore().updateStatus(param(event, 'status'), await readBody(event), await actorOf(event)))
