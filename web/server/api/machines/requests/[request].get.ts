import {connectRequest} from '../../../utils/machine-connect'

// `GET /api/machines/requests/:request` → {name, words, expires_at, approved} (ORR-1192): a machine asking to connect, as
// its Connect page shows it to whoever's signed in; 404 once it's run out or was never made.
export default defineEventHandler(event => {
    const found = connectRequest(getRouterParam(event, 'request'))
    if (!found) throw notFound('This request to connect has run out: run the line on the computer again')
    return found
})
