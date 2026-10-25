// `PUT /api/secrets/:name` {value, hosts, projects?} → the secret, created (201) or replaced: the owner's
// only. Nothing gives the value back.
export default defineEventHandler(async event => {
    const {secret, created: isNew} = await useSecrets().set(param(event, 'name'), await readBody(event), await actorOf(event))
    return isNew ? created(event, secret) : secret
})
