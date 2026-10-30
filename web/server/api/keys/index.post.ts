// `POST /api/keys` {kind, name, person?} → 201 the key, with `key` this once only. `agent` goes in a machine's ORRERY_KEY, and
// `person` signs in to the page. `person` is the owner's to give, for handing someone a key on a server with no provider.
export default defineEventHandler(async event => {
    const {person, owner} = await keyHolderOf(event)
    const body = (await readBody<{kind?: unknown, name?: unknown, person?: unknown}>(event)) ?? {}
    const whose = typeof body.person === 'string' ? body.person : person
    if (whose !== person && !owner) throw refusedFor('keys.write', 'A person makes their own keys; only the owner gives them to others')
    const key = await useStore().makeKey(whose, body)
    setResponseStatus(event, 201)
    return key
})
