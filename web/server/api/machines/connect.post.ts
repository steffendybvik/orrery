import {machineName, makeConnectRequest, takeConnectCode} from '../../utils/machine-connect'
import {machineKey} from '../../utils/machine-key'

// `POST /api/machines/connect` {name, code?} (ORR-1192), the launcher connecting its machine, open as it has nothing else
// yet. With the install line's code: 201 {key, person}, using the code up. Without one: 201 {request, secret, words, url,
// expires_at}, a request whose page (`url`) the person opens, checks `words` against the terminal, and presses Connect
// on; the launcher then asks for the key with `secret` (`POST /api/machines/claim`).
export default defineEventHandler(async event => {
    const {name, code} = (await readBody<{name?: unknown, code?: unknown}>(event)) ?? {}
    const machine = machineName(name)
    if (code !== undefined && code !== null && code !== '') {
        const person = takeConnectCode(code)
        if (!person) throw createError({statusCode: 401, statusMessage: 'Unauthorized', message: 'That install line has been used or has run out: copy it again from the page'})
        setResponseStatus(event, 201)
        return {key: await machineKey(person, machine), person}
    }
    const made = makeConnectRequest(machine)
    setResponseStatus(event, 201)
    return {...made, url: `${getRequestURL(event, {xForwardedHost: true, xForwardedProto: true}).origin}/connect-machine?request=${encodeURIComponent(made.request)}`}
})
