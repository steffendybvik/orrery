import type {Who} from '../../utils/auth'
import {makeConnectCode} from '../../utils/machine-connect'

// `POST /api/machines/code` → 201 {code, expires_at}: a one-time code for the install line the signed-in page shows
// (ORR-1192), so pasting it connects the machine with nothing else to do. A person's own, from their page: never a
// session, which would hand its person's key to whoever it gave the code. With login off the line needs none: 409.
export default defineEventHandler(async event => {
    await authorize(event, 'machines.approve')
    if (await authMode(event) === 'off') throw conflict('Login is off here, so the install line needs no code')
    const who = event.context?.who as Who | undefined
    if (who?.via !== 'browser') throw createError({statusCode: 403, statusMessage: 'Forbidden', message: 'A code for the install line is made from your own page, signed in'})
    setResponseStatus(event, 201)
    return makeConnectCode(who.person)
})
