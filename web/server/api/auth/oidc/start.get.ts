// `GET /api/auth/oidc/start?invite=&back=&someone_else=1` → a redirect to the provider's login. `someone_else`: ask the
// provider for its login form even with a session of its own (`prompt=login`, ORR-1319), to sign in as another account. `back`: the page's origin, when it's hosted
// on a site listed in NUXT_ALLOWED_ORIGINS (ORR-667), to come back to; any other is ignored. 404 when no provider is set up.
export default defineEventHandler(async event => {
    if (!oidcOn()) throw notFound('This orrery has no login provider')
    const {invite, back, someone_else: someoneElse} = getQuery(event)
    return sendRedirect(event, await startOidc(event, typeof invite === 'string' && invite ? invite : undefined, typeof back === 'string' ? back : undefined,
        someoneElse === '1' || someoneElse === 'true'))
})
