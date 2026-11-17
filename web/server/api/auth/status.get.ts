import {viaPhone} from '../../utils/phone-port'

// `GET /api/auth/status` → {mode, person?, via?, can_get_in, oidc, sign_up, warn_http, phone}: whether this orrery asks for a login,
// who this browser is, `sign_up` when its provider lets someone new in (ORRERY_SIGN_UP, ORR-1291), and `phone` on the phone's own port (ORR-837). Open, as the login page needs it first; it says nothing about anyone else.
export default defineEventHandler(async event => {
    const mode = await authMode(event)
    const who: Who | undefined = event.context.who
    const http = !overHttps(event) && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/.test(getRequestHost(event))
    return {mode, ...who ? {person: who.person, via: who.via} : {}, can_get_in: await canGetIn(), oidc: oidcOn(), sign_up: oidcOn() && process.env.ORRERY_SIGN_UP?.trim().toLowerCase() !== 'invite', warn_http: mode === 'on' && http, phone: viaPhone(event)}
})
