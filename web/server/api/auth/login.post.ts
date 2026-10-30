// `POST /api/auth/login` {key} → {person}: swaps a person key for a login's cookie, for a server with no provider (and for
// the owner's first login, with the key `orrery:claim` printed). An agent key can't sign in, so an agent can't become its person.
export default defineEventHandler(async event => {
    const {key} = (await readBody<{key?: unknown}>(event)) ?? {}
    const holder = typeof key === 'string' ? await useStore().keyHolder(key.trim()) : undefined
    if (holder?.kind !== 'person') throw createError({statusCode: 401, statusMessage: 'Unauthorized', message: "That isn't a person key on this orrery, or it's been revoked"})
    await logIn(event, holder.person)
    return {person: holder.person}
})
