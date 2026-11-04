import {viaPhone} from '../../utils/phone-port'

// `GET /api/auth/status` → {mode, person?, via?, can_get_in, can_claim, named, oidc, warn_http, phone}: whether this orrery asks for a login, and who
// this browser is, and whether it may claim the orrery here (ORR-832), naming its owner if `named` is false, and `phone` on the phone's own port (ORR-837). Open, as the login page needs it first; it says nothing about anyone else.
export default defineEventHandler(async event => {
    const mode = await authMode(event)
    const who: Who | undefined = event.context.who
    const http = !overHttps(event) && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?$/.test(getRequestHost(event))
    return {mode, ...who ? {person: who.person, via: who.via} : {}, can_get_in: await canGetIn(), can_claim: !await claimRefusal(event, {asking: false}), named: (await useStore().ownerOf()).named, oidc: oidcOn(), warn_http: mode === 'on' && http, phone: viaPhone(event)}
})
