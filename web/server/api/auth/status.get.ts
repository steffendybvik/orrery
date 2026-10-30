// `GET /api/auth/status` → {mode, person?, via?, can_get_in, oidc, warn_http}: whether this orrery asks for a login, and who
// this browser is. Open, as the login page needs it first; it says nothing about anyone else.
export default defineEventHandler(async event => {
    const mode = await authMode(event)
    const who: Who | undefined = event.context.who
    const http = !overHttps(event) && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/.test(getRequestHost(event))
    return {mode, ...who ? {person: who.person, via: who.via} : {}, can_get_in: await canGetIn(), oidc: oidcOn(), warn_http: mode === 'on' && http}
})
