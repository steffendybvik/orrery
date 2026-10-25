// `PUT /api/owner` {name} → the owner: names them, `Sköll Fenrisson` making the id `skoll_fenrisson`. Anyone
// may the first time; then only the owner. What was theirs under the old id moves to the new one.
export default defineEventHandler(async event => useStore().nameOwner(await readBody(event), actorOf(event)))
