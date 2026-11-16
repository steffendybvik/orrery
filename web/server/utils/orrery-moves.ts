// Moving a whole orrery into another from App settings (ORR-1249): the same import as `pnpm orrery:import` (ORR-1110),
// run by this server. One side is this orrery, asked again as the owner's page that asked, so it passes the same checks
// their browser does; the other is the orrery at the address they gave, with the owner key they
// pasted. `send` makes this orrery the source (a hosted orrery can't reach one on `localhost`, so moving a local one up
// is a send); `bring` makes it the target.
// A run lives in memory: the key with it, never stored or logged, and gone an hour after it ends. A restart loses a run
// that hasn't ended, which the page says, and running it again with "Add to it" leaves the boards that arrived alone.
import type {H3Event} from 'h3'
import {randomUUID} from 'node:crypto'
import {request} from 'node:http'
import * as script from '#shared/import-orrery.mjs'

/** One orrery, as the import's client reaches it. */
interface OrreryClient {
    url: string
    get: (path: string, options?: {workspace?: string}) => Promise<unknown>
}

// The import is plain JavaScript, shared with the command line (shared/import-orrery.mjs), so typed here as it's used.
const {client, importOrrery, summary} = script as unknown as {
    client: (base: string, options?: {key?: string, person?: string, fetch?: typeof fetch}) => OrreryClient
    importOrrery: (options: Record<string, unknown>) => Promise<unknown>
    summary: (report: unknown) => string
}

export type MoveDirection = 'send' | 'bring'

export interface MoveAsk {
    direction: MoveDirection
    url: string
    key: string
    name: string
    /** The workspace that's moved: this orrery's on a send (the page's), the other's on a bring. */
    from: string
    color?: string
    add?: boolean
    dryRun?: boolean
    enableSchedules?: boolean
}

export interface MoveProgress {
    step: 'reading' | 'uploading' | 'finishing'
    project?: string
    done: number
    total: number
}

export interface OrreryMove {
    id: string
    direction: MoveDirection
    remote: string
    workspace: string
    state: 'running' | 'done' | 'failed'
    progress?: MoveProgress
    lines: string[]
    report?: unknown
    summary?: string
    error?: string
    started: number
    ended?: number
}

const runs = new Map<string, OrreryMove>()
const KEEP = 60 * 60 * 1000
const TINTS = ['slate', 'blue', 'teal', 'green', 'amber', 'rose', 'violet']

/** The headers of the owner's own request that say who they are and that it's this orrery's page, for the requests this
 * server makes to itself on their behalf: the import's client sets the workspace and the body's type itself. */
const DROP = new Set(['content-length', 'content-type', 'transfer-encoding', 'accept-encoding', 'connection', 'orrery-workspace', 'orrery-session', 'expect'])

/** A `fetch` that asks this server again, as the page that asked: over the very address and port that request came in on,
 * with its headers (`Host`, `Origin`, the login cookie, a proxy's `X-Forwarded-*`), so each request passes the checks the
 * owner's browser did, and no others. `node:http`, as `fetch` won't send another `Host`. */
function selfFetch(event: H3Event): typeof fetch {
    const asked: Record<string, string> = {}
    for (const [name, value] of Object.entries(getRequestHeaders(event))) if (value !== undefined && !DROP.has(name.toLowerCase())) asked[name] = value
    const socket = event.node.req.socket as typeof event.node.req.socket & {server?: {address?: () => unknown}}
    // `nuxt dev` hands requests on over a socket file of its own, which is then the way back in.
    const bound = socket.server?.address?.()
    const way = typeof bound === 'string' ? {socketPath: bound} : {host: (socket.localAddress ?? '127.0.0.1').replace(/^::ffff:/, ''), port: socket.localPort}
    return (async (input: string, init: RequestInit = {}) => {
        const url = new URL(input)
        const body = init.body === undefined || init.body === null ? undefined : Buffer.from(init.body as string)
        const headers = {...asked, ...init.headers as Record<string, string>, ...body ? {'content-length': String(body.length)} : {}}
        return await new Promise<Response>((resolve, reject) => {
            const req = request({...way, path: url.pathname + url.search, method: init.method ?? 'GET', headers}, res => {
                const chunks: Buffer[] = []
                res.on('data', chunk => chunks.push(chunk))
                res.on('end', () => resolve(new Response(Buffer.concat(chunks), {status: res.statusCode ?? 500, headers: {'content-type': String(res.headers['content-type'] ?? 'application/json')}})))
                res.on('error', reject)
            })
            req.on('error', reject)
            req.end(body)
        })
    }) as typeof fetch
}

/** The other orrery's address, as `https://host[:port]`: https, or plain http only to this machine, as a login's
 * provider is held to (api/src/access/oidc.rs `secure`). No path, user or query. */
export function moveRemoteOrigin(value: string): string {
    let url: URL
    try {
        url = new URL(String(value ?? '').trim())
    } catch {
        throw badRequest('Give the other orrery\'s address, like https://orrery.example.com')
    }
    const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw badRequest('The other orrery\'s address has to be https (plain http only to this machine)')
    if (url.username || url.password || url.search || url.hash) throw badRequest('Give the other orrery\'s address alone, with no login, query or #')
    return url.origin
}

/** What a move asks, checked: the fields `importOrrery` takes, and the remote's address. */
export function moveAskOf(body: unknown): MoveAsk {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    if (b.direction !== 'send' && b.direction !== 'bring') throw badRequest('"direction" is "send" or "bring"')
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name || name.length > 60) throw badRequest('Name the workspace it goes into (60 characters at most)')
    const key = typeof b.key === 'string' ? b.key.trim() : ''
    if (b.color !== undefined && b.color !== null && !(typeof b.color === 'string' && (TINTS.includes(b.color) || /^#[0-9a-f]{6}$/i.test(b.color)))) throw badRequest(`"color" is one of ${TINTS.join(', ')}, or #rrggbb`)
    return {
        direction: b.direction,
        url: moveRemoteOrigin(String(b.url ?? '')),
        key,
        name,
        from: typeof b.from === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(b.from) ? b.from : 'default',
        ...typeof b.color === 'string' ? {color: b.color} : {},
        add: b.add === true,
        dryRun: b.dryRun === true,
        enableSchedules: b.enableSchedules === true,
    }
}

/** Only the owner, from their own page: not a key, a session, a chat or an untrusted one. With login off, the owner's
 * page is the request that names the owner and isn't a session's. */
export async function moveByOwnersPage(event: H3Event) {
    const who = event.context?.who as {via?: string, owner?: boolean} | undefined
    const actor = await actorOf(event)
    const page = who ? who.via === 'browser' && who.owner : actor.owner && !actor.session && !sessionHeader(event)
    if (!page || actor.chat || actor.untrusted) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: 'Only the owner moves an orrery, from its page'})
}

/** The two sides, as `importOrrery` takes them: this orrery through its own handler, the other with the key. */
export async function moveSides(event: H3Event, ask: MoveAsk) {
    const here = getRequestURL(event, {xForwardedHost: true, xForwardedProto: true}).origin
    if (new URL(ask.url).host === new URL(here).host) throw badRequest('That address is this orrery')
    // With login off there, no key: the requests name its owner, as the command line does.
    const remote = client(ask.url, ask.key ? {key: ask.key} : {person: await ownerThere(ask.url)})
    const self = client(here, {fetch: selfFetch(event)})
    // The remote, checked before anything runs: that the key gets in as its owner, and that it has workspaces.
    const workspaces = await remote.get('/workspaces').catch((error: {status?: number, message: string}) => {
        if (error.status === 401 || error.status === 403) throw badRequest(`${ask.url} didn't take that key: give a person key of its owner (App settings → You → Keys there)`)
        throw badRequest(`Couldn't reach ${ask.url}: ${error.message}`)
    })
    if (!Array.isArray(workspaces)) throw badRequest(`${ask.url} has no workspaces: it needs orrery 1.0.0-rc.19 or later`)
    return ask.direction === 'send' ? {source: self, target: remote, workspaces} : {source: remote, target: self, workspaces}
}

/** A move, run in the background; the page follows it by its id. */
export function startMove(run: Omit<OrreryMove, 'id' | 'state' | 'lines' | 'started'>, go: (hooks: {log: (line: string) => void, progress: (p: MoveProgress) => void}) => Promise<unknown>): OrreryMove {
    prune()
    const entry: OrreryMove = {...run, id: randomUUID(), state: 'running', lines: [], started: Date.now()}
    runs.set(entry.id, entry)
    go({log: line => entry.lines.push(line), progress: p => { entry.progress = p }})
        .then(report => {
            entry.report = report
            entry.summary = summary(report)
            entry.state = 'done'
        })
        .catch((error: Error) => {
            entry.error = error.message
            entry.state = 'failed'
        })
        .finally(() => { entry.ended = Date.now() })
    return entry
}

export const moveRun = (id: string): OrreryMove | undefined => {
    prune()
    return runs.get(id)
}

function prune(now = Date.now()) {
    for (const [id, run] of runs) if (run.ended && now - run.ended > KEEP) runs.delete(id)
}

/** Forgets every run, for tests. */
export const forgetMoves = () => runs.clear()

/** The import itself, for the routes. */
export const importWholeOrrery = importOrrery

/** The text the owner reads at the end of a move, or of its preview. */
export const moveSummary = (report: unknown): string => summary(report)

async function ownerThere(url: string): Promise<string | undefined> {
    const owner = await client(url).get('/owner').catch(() => undefined) as {name?: string} | undefined
    return owner?.name
}

function badRequest(message: string) {
    return createError({statusCode: 400, statusMessage: 'Bad Request', message})
}
