// `GET /api/auth/oidc/callback` → a redirect to the board, logged in (to its page on another site when it started there,
// ORR-667): where the provider sends the browser back. On an orrery with nobody on it yet, the first account in becomes
// its owner (ORR-1185); after that, an account orrery doesn't know needs an invite, so nobody gets in only by having an
// account with the provider.
export default defineEventHandler(async event => {
    if (!oidcOn()) throw notFound('This orrery has no login provider')
    const {issuer, subject, name, invite, back} = await finishOidc(event)
    const person = await useStore().identity(issuer, subject, invite, name)
    if (!person) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: "This account isn't on this orrery: ask its owner for an invite"})
    await logIn(event, person)
    return sendRedirect(event, back ? `${back}/` : '/')
})
