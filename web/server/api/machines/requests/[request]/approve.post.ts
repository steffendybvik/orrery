import type {Who} from '../../../../utils/auth'
import {approveConnectRequest} from '../../../../utils/machine-connect'

// `POST /api/machines/requests/:request/approve` → 204 (ORR-1192): the person signed in says yes, and the machine that
// asked gets an agent key of theirs, reaching every workspace they're in, the next time its launcher asks. Only from a
// person's own page: a session never connects a machine as its person. 404 once it's run out.
export default defineEventHandler(async event => {
    // A member in person is let through by the table's `member` cell (`checkBoards`): `authorize` alone would class
    // them as a session (ORR-1348). Anyone else, an agent of theirs included, goes on to it and is refused.
    if (!await memberAsking(event)) await authorize(event, 'machines.approve')
    if (await authMode(event) === 'off') throw conflict('Login is off here, so a machine needs no key to connect')
    const who = event.context?.who as Who | undefined
    const person = who?.via === 'browser' ? who.person : undefined
    if (!person) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: 'A machine is connected from your own page, signed in'})
    if (!approveConnectRequest(getRouterParam(event, 'request'), person)) throw notFound('This request to connect has run out: run the line on the computer again')
    setResponseStatus(event, 204)
    return null
})
