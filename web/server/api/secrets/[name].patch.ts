// `PATCH /api/secrets/:name` {hosts?, projects?} → the secret, going to fewer places: the owner's only.
// Widening them takes the value again (PUT).
export default defineEventHandler(async event => useSecrets().narrow(param(event, 'name'), await readBody(event), await actorOf(event)))
