import {claimConnectRequest} from '../../utils/machine-connect'
import {machineKey} from '../../utils/machine-key'

// `POST /api/machines/claim` {request, secret} (ORR-1192): the launcher asking whether its request was approved. 202
// {waiting: true} until it is, then 201 {key, person}, once; 410 once it's gone (run out, or never made). Open, as the
// secret only the launcher holds is what it asks with.
export default defineEventHandler(async event => {
    const {request, secret} = (await readBody<{request?: unknown, secret?: unknown}>(event)) ?? {}
    const said = claimConnectRequest(request, secret)
    if ('gone' in said) throw createError({statusCode: 410, statusMessage: 'Gone', message: 'This request to connect has run out: run the line again'})
    if ('waiting' in said) {
        setResponseStatus(event, 202)
        return {waiting: true}
    }
    setResponseStatus(event, 201)
    return {key: await machineKey(said.person, said.name), person: said.person}
})
