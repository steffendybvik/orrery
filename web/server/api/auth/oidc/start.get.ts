// `GET /api/auth/oidc/start?invite=&back=` → a redirect to the provider's login. `back`: the page's origin, when it's hosted
// on a site listed in NUXT_ALLOWED_ORIGINS (ORR-667), to come back to; any other is ignored. 404 when no provider is set up.
export default defineEventHandler(async event => {
    if (!oidcOn()) throw notFound('This orrery has no login provider')
    const {invite, back} = getQuery(event)
    return sendRedirect(event, await startOidc(event, typeof invite === 'string' && invite ? invite : undefined, typeof back === 'string' ? back : undefined))
})
