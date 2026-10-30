// `GET /api/auth/oidc/callback` → a redirect to the board, logged in: where the provider sends the browser back. An account
// orrery doesn't know needs an invite, so nobody gets in only by having an account with the provider.
export default defineEventHandler(async event => {
    if (!oidcOn()) throw notFound('This orrery has no login provider')
    const {issuer, subject, invite} = await finishOidc(event)
    const person = await useStore().identity(issuer, subject, invite)
    if (!person) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: "This account isn't on this orrery: ask its owner for an invite"})
    await logIn(event, person)
    return sendRedirect(event, '/')
})
