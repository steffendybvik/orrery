// `POST /api/invites` {person} → 201 {url, expires_at}: a link good once and for a week, whose first login attaches that
// account to the person. The owner's only, and only with a login provider to log in through.
export default defineEventHandler(async event => {
    const {owner} = await keyHolderOf(event)
    if (!owner) throw refusedFor('keys.write', 'Only the owner invites people')
    if (!oidcOn()) throw conflict('This orrery has no login provider to invite someone through: give them a person key instead (POST /api/keys)')
    const {person} = (await readBody<{person?: unknown}>(event)) ?? {}
    if (typeof person !== 'string') throw badRequest('"person" is the id of who to invite')
    const {secret, expires_at} = await useStore().invite(person)
    setResponseStatus(event, 201)
    return {url: `${getRequestURL(event, {xForwardedHost: true, xForwardedProto: true}).origin}/login?invite=${secret}`, expires_at}
})
