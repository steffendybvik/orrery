import {PHONE_LOGIN} from '../../utils/phone-sign-in'

// `POST /api/auth/link` {token} → 201 {person}: signs this browser in with a one-time link from App settings' QR code
// (ORR-837), using it up. The login is the phone's own, named so, so it's ended on its own from App settings (ORR-838). Open, as
// the browser has nothing else yet.
export default defineEventHandler(async event => {
    const {token} = (await readBody<{token?: unknown}>(event)) ?? {}
    const person = takeSignInLink(token)
    if (!person) throw createError({statusCode: 401, statusMessage: 'Unauthorized', message: 'This sign-in link has been used or has run out: show the QR code in App settings again'})
    await logIn(event, person, undefined, PHONE_LOGIN)
    setResponseStatus(event, 201)
    return {person}
})
