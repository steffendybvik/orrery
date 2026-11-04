// `POST /api/auth/link` {token} → 201 {person}: signs this browser in with a one-time link from App settings' QR code
// (ORR-837), using it up. The login is the phone's own, so it's ended on its own (Your logins) or with the rest. Open, as
// the browser has nothing else yet.
export default defineEventHandler(async event => {
    const {token} = (await readBody<{token?: unknown}>(event)) ?? {}
    const person = takeSignInLink(token)
    if (!person) throw createError({statusCode: 401, statusMessage: 'Unauthorized', message: 'This sign-in link has been used or has run out: show the QR code in App settings again'})
    await logIn(event, person)
    setResponseStatus(event, 201)
    return {person}
})
