// `PUT /api/owner` {name} → the owner: names them, `Steffen Dybvik` making the id `steffen_dybvik`. Anyone
// may the first time; then only the owner. What was theirs under the old id moves to the new one.
export default defineEventHandler(async event => useStore().nameOwner(await readBody(event), actorOf(event)))
