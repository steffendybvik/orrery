// `POST /api/phone/link` → 201 {token, expires_at}: a one-time sign-in link for App settings' QR code (ORR-837), good once
// for a few minutes. The phone opens `<address>/login?t=<token>` on the phone's port and is signed in as the owner. Only
// the owner makes one, from the main address: with login off there, that's this machine's page. Never over the phone's
// port, so a phone signed in can't hand out more.
import type {Who} from '../../utils/auth'

export default defineEventHandler(async event => {
    if (viaPhone(event)) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: "A sign-in link is made from orrery's page on its own machine"})
    const mode = await authMode(event)
    const who = event.context.who as Who | undefined
    if (mode !== 'off' && !(who?.owner && who.via === 'browser')) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: 'Only the owner makes a sign-in link, from their own page'})
    // A session, the chat or an untrusted one never: it would get a login as the owner.
    await authorize(event, 'phone.link')
    const owner = await useStore().ownerOf()
    if (!owner.named) throw conflict('This orrery has no owner yet: give your name first (App settings → You)')
    setResponseStatus(event, 201)
    return makeSignInLink(owner.name)
})
