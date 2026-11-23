// `GET /api/auth/oidc/logout?back=` → a redirect to the provider's own sign-out, then back to the login page (ORR-1319):
// where the page sends the browser once `POST /api/auth/logout` has ended orrery's login, so the provider's session ends
// too. A provider with no `end_session_endpoint` sends it straight to the login page. `back`: the page's origin, when
// it's hosted on a site listed in NUXT_ALLOWED_ORIGINS (ORR-667); any other is ignored. 404 when no provider is set up.
export default defineEventHandler(async event => {
    if (!oidcOn()) throw notFound('This orrery has no login provider')
    const {back} = getQuery(event)
    return sendRedirect(event, await endOidc(event, typeof back === 'string' ? back : undefined))
})
