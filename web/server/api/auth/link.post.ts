import {PHONE_LOGIN} from '../../utils/phone-sign-in'

// `POST /api/auth/link` {token} or {code} → 201 {person}: signs this browser in with a one-time link from App settings'
// QR code (ORR-837), or the six-letter code shown under it (ORR-875), using it up. The login is the phone's own, named
// so, so it's ended on its own from App settings (ORR-838). Open, as the browser has nothing else yet.
export default defineEventHandler(async event => {
    const {token, code} = (await readBody<{token?: unknown, code?: unknown}>(event)) ?? {}
    const typed = code !== undefined
    const person = typed ? takeSignInCode(code) : takeSignInLink(token)
    if (!person) {
        throw createError({
            statusCode: 401,
            statusMessage: 'Unauthorized',
            message: typed
                ? 'That code is wrong, used or has run out: check it against App settings on your computer, or press New code there'
                : 'This sign-in link has been used or has run out: show the QR code in App settings again',
        })
    }
    await logIn(event, person, undefined, PHONE_LOGIN)
    setResponseStatus(event, 201)
    return {person}
})
