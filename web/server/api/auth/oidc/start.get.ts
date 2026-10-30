// `GET /api/auth/oidc/start?invite=` → a redirect to the provider's login. 404 when no provider is set up.
export default defineEventHandler(async event => {
    if (!oidcOn()) throw notFound('This orrery has no login provider')
    const {invite} = getQuery(event)
    return sendRedirect(event, await startOidc(event, typeof invite === 'string' && invite ? invite : undefined))
})
