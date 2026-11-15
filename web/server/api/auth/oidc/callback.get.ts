// `GET /api/auth/oidc/callback` → a redirect to the board, logged in (to its page on another site when it started there,
// ORR-667): where the provider sends the browser back. On an orrery with nobody on it yet, the first account in becomes
// its owner (ORR-1185). After that, someone new the provider lets in gets a person and a workspace of their own, unless
// ORRERY_SIGN_UP=invite asks for an invite (ORR-1180). Who the account is, the API says (`POST /api/auth/identity`),
// as sign-up is its alone; with no API set up (unit tests), the store here, which knows invites and the first owner.
import {writeToApi} from '../../../utils/api-router'
import {ORRERY} from '../../../store/schema'

export default defineEventHandler(async event => {
    if (!oidcOn()) throw notFound('This orrery has no login provider')
    const {issuer, subject, name, invite, back} = await finishOidc(event)
    const asked = await writeToApi('POST', '/api/auth/identity', {issuer, subject, invite, name}, ORRERY, {always: true})
    const person = asked ? (asked.reply as {person: string | null}).person ?? undefined : await useStore().identity(issuer, subject, invite, name)
    if (!person) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: "This account isn't on this orrery: ask its owner for an invite"})
    await logIn(event, person)
    return sendRedirect(event, back ? `${back}/` : '/')
})
