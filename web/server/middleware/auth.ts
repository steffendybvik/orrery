// With auth on (ORR-664), every route under /api asks for a credential, reads included, so the checks after this are
// against a verified person. There's no loopback exemption, as in Docker orrery can't tell loopback from the network.
// Runs first, but for 0-cors.ts (a listed site's preflight, which carries no credential) and 0-pages.ts (ORR-667).
// What stays open is what can't hold data: the login's own routes (a phone's one-time link among them, ORR-837), and
// outside /api the page's files, the
// channel's, and /llms* and /connect, which leave out what's on this orrery unless `mayRead` says otherwise (ORR-689).
// Off, as on one person's own machine, this does nothing.
import {authMode, canGetIn, credential, holdSession, noteOtherPerson, pathOf} from '../utils/auth'
import {viaPhone} from '../utils/phone-port'

const OPEN = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/logout', '/api/auth/link', '/api/auth/oidc/start', '/api/auth/oidc/callback'])
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export default defineEventHandler(async event => {
    const path = pathOf(event)
    // `/mcp` too: the Rust API's MCP tools (ORR-1102), each a route of its own inside it.
    if (path !== '/api' && !path.startsWith('/api/') && path !== '/mcp') return
    const mode = await authMode(event)
    if (mode === 'off') return
    if (OPEN.has(path)) {
        if (mode === 'on') event.context.who = await credential(event)
        return
    }
    if (mode === 'closed') throw createError({statusCode: 503, statusMessage: 'Service Unavailable', message: 'ORRERY_AUTH=off only works while orrery listens on loopback, and this one is reachable from other machines: unset it'})
    const who = await credential(event)
    if (!who) {
        if (!viaPhone(event) && !await canGetIn()) throw createError({statusCode: 503, statusMessage: 'Service Unavailable', message: 'Nobody can log in to this orrery yet: claim it from its page on its own machine (App settings → You), or run `pnpm orrery:claim` there (in Docker, `docker compose exec orrery node /app/server/claim.mjs`)'})
        throw createError({statusCode: 401, statusMessage: 'Unauthorized', message: 'This orrery asks for a credential: log in on its page, or give a session an agent key (ORRERY_KEY)'})
    }
    // A cookie goes along by itself, so a write on one has to say it comes from a page, which writes.ts then checks is ours.
    if (who.via === 'browser' && WRITES.has(event.method) && !getHeader(event, 'origin')) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: "A logged-in write comes from orrery's own page"})
    event.context.who = who
    noteOtherPerson(event, who)
    if (WRITES.has(event.method)) await holdSession(event, getHeader(event, 'orrery-session'))
})
