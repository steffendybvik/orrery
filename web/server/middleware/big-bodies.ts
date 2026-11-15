// How much of a request's body orrery will hold in memory (ORR-753), as reading one buffers all of it. It runs after auth.ts,
// so only a request with a credential gets here, apart from the login's own open routes, which get very little. And before
// anything reads a body. A body with no length is read here, as it comes, up to the limit, and left for the route.
import {BOARD_LIMIT} from '../utils/board-upload'
import {pathOf} from '../utils/auth'
import {UPLOAD_BODY_LIMIT} from '../store/schema'

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const LOGIN_LIMIT = 64 * 1024
/** Eight times the biggest doc there is (about 120 KB), and the Rust API's own (ORR-1062). Images have their own. */
const LIMIT = 1024 * 1024

function limitOf(path: string): number {
    if (path.startsWith('/api/auth/')) return LOGIN_LIMIT
    if (path === '/api/projects/upload' || /^\/api\/projects\/[^/]+\/import\/?$/.test(path)) return BOARD_LIMIT
    if (/^\/api\/uploads\/?$/.test(path)) return UPLOAD_BODY_LIMIT
    return LIMIT
}

export default defineEventHandler(async event => {
    const path = pathOf(event)
    if (!WRITES.has(event.method) || !path.startsWith('/api/')) return
    const limit = limitOf(path)
    const tooBig = () => createError({statusCode: 413, statusMessage: 'Payload Too Large', message: `A request's body is ${limit / 1024 / 1024} MB at most here`})
    if (Number(getHeader(event, 'content-length') ?? 0) > limit) throw tooBig()
    if (!getHeader(event, 'transfer-encoding')) return
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of event.node.req as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > limit) throw tooBig()
        chunks.push(chunk)
    }
    // Where h3's readBody and readRawBody look first.
    event._requestBody = Buffer.concat(chunks)
})
