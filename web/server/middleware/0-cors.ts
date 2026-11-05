// Cross-origin access to the API, for a frontend hosted on another site (ORR-667). It runs before the login check, as a
// browser's preflight carries no credential. Only a page whose origin is listed in NUXT_ALLOWED_ORIGINS (utils/origins.ts)
// is answered: its preflight, and its requests' answers, with that one origin and credentials allowed, so the browser
// sends the login cookie along and lets the page read the reply. Every other origin gets no CORS headers at all, so the
// browser keeps its answers from the page, and writes.ts still refuses its writes. With nothing listed, this does nothing.
import {pathOf} from '../utils/auth'
import {originAllowed} from '../utils/origins'

const METHODS = 'GET, POST, PUT, PATCH, DELETE'
// What orrery's page sends besides the safe ones: the JSON body's type and who it acts as (utils/api.ts).
const HEADERS = 'Content-Type, Orrery-Actor'

export default defineEventHandler(event => {
    const path = pathOf(event)
    if (path !== '/api' && !path.startsWith('/api/')) return
    const origin = getHeader(event, 'origin')
    if (!origin || !originAllowed(origin)) return
    setResponseHeaders(event, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
    })
    if (event.method === 'OPTIONS' && getHeader(event, 'access-control-request-method')) {
        setResponseHeaders(event, {
            'Access-Control-Allow-Methods': METHODS,
            'Access-Control-Allow-Headers': HEADERS,
            'Access-Control-Max-Age': '600',
        })
        setResponseStatus(event, 204)
        return ''
    }
})
