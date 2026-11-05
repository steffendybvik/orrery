// The router in front of the Rust API (ORR-922, api/): with `apiUrl` and `apiToken` set, a request for a domain it serves
// goes there, after everything here has checked it as ever (auth, the board's permissions, the chat's and untrusted
// sessions' rails, the browser guards: the middleware before zz-api.ts). Both run on the same database, one writer per
// table, so while the API serves docs nothing else here writes docs except what it can't yet reach (the chat's doc
// requests, a board's upload or copy, deleting a project), which work on the same rows.
//
// It sends who's asking (`actorOf`) and which database this server is on, and the API's reply says what a write changed,
// which this tells as the store would: open pages read the project again, and the event log and schedules hear the event.
// When the API is down, or is on another database (the owner moved it), the request falls through to the routes here.
import {createHash} from 'node:crypto'
import type {H3Event} from 'h3'
import {createError, getRequestHeader, readRawBody, setResponseHeader, setResponseStatus} from 'h3'
import type {Actor} from '../store/schema'

/** The domains the Rust API serves, a line each (ORR-925): moving a domain there is adding its line once the parity test
 * passes, and taking it back to the routes here is taking the line out. Each matches a whole path after `/api/`, with no
 * slash at the end, and takes every method its routes do. */
export const DOMAINS: readonly {domain: string, paths: RegExp}[] = [
    // A project's docs, their revisions and sections (ORR-922). An artifact's page stays here: it's drawn with the
    // page's own sanitising and its locked-down headers (`artifact.get.ts`).
    {domain: 'docs', paths: /^projects\/[^/]+\/(docs(\/[^/]+(\/revisions(\/[^/]+(\/restore)?)?)?)?|deleted-docs|doc-sections(\/[^/]+)?)$/},
]

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** The domain whose line sends `path` (as `pathOf` gives it) to the Rust API, or undefined for the routes here. */
export function domainOf(path: string): string | undefined {
    const rest = /^\/api\/(.*?)\/?$/.exec(path)?.[1]
    return rest === undefined ? undefined : DOMAINS.find(({paths}) => paths.test(rest))?.domain
}

/** Whether the Rust API serves `path`, whatever the method: its routes take the same ones these do. */
export function servedByApi(path: string): boolean {
    return domainOf(path) !== undefined
}

/** The database as the API is told it: its setting hashed, as a Postgres URL holds a password. */
export function databaseMark(setting: string): string {
    return createHash('sha256').update(setting).digest('hex')
}

/** The headers saying who's asking, as the API reads them: its name and session percent-encoded, as a header is ASCII. */
export function actorHeaders(actor: Actor): Record<string, string> {
    return {
        'Orrery-Actor-Name': encodeURIComponent(actor.name),
        'Orrery-Actor-Owner': actor.owner ? '1' : '0',
        ...actor.session ? {'Orrery-Actor-Session': encodeURIComponent(actor.session)} : {},
    }
}

/** What a reply's `Orrery-Told` says happened: `<type> <project> <subject>, …`, each part percent-encoded. */
export function toldOf(header: string | null): {type: string, project: string, subject: string}[] {
    if (!header) return []
    return header.split(',').map(part => part.trim().split(' ').map(decodeURIComponent)).filter(parts => parts.length === 3)
        .map(([type = '', project = '', subject = '']) => ({type, project, subject}))
}

/** The API this server started itself (`plugins/api.ts`), once it's listening. */
let started: {url: string, token: string} | null = null

export function apiStarted(api: {url: string, token: string} | null) {
    started = api
}

/** Where the API is, and its token: the one this server started, or the one the settings name; none, no API. */
export function apiTarget(config: {apiUrl?: unknown, apiToken?: unknown}): {url: string, token: string} | null {
    if (started) return started
    return config.apiUrl && config.apiToken ? {url: String(config.apiUrl), token: String(config.apiToken)} : null
}

/** Said once, not on every request, while the API can't be reached. */
let unreachable = false

/** Sends the request to the API and gives back its reply, or undefined to leave it to the routes here. */
export async function forwardToApi(event: H3Event, api: {url: string, token: string}): Promise<unknown> {
    const actor = await actorOf(event)
    const body = WRITES.has(event.method) ? await readRawBody(event, false) : undefined
    let response: Response
    try {
        response = await fetch(`${api.url.replace(/\/+$/, '')}${event.path}`, {
            method: event.method,
            headers: {
                'Content-Type': getRequestHeader(event, 'content-type') ?? 'application/json',
                'Orrery-Api-Token': api.token,
                'Orrery-Database': databaseMark(databaseSetting()),
                ...actorHeaders(actor),
            },
            body: body ? new Uint8Array(body) : undefined,
            redirect: 'manual',
        })
    } catch (error) {
        if (!unreachable) console.warn(`[orrery] the Rust API at ${api.url} can't be reached, so this server answers its routes:`, (error as Error).message)
        unreachable = true
        return undefined
    }
    unreachable = false
    // On another database than this server's: the owner moved it, and the API hasn't been started again on the new one.
    if (response.status === 421) return undefined
    const text = await response.text()
    const json = text ? JSON.parse(text) as Record<string, unknown> : null
    if (response.status >= 400) {
        throw createError({statusCode: response.status, statusMessage: String(json?.statusMessage ?? ''), message: String(json?.message ?? ''), ...json?.data === undefined ? {} : {data: json.data}})
    }
    const store = useStore()
    const changed = response.headers.get('orrery-changed')
    if (changed) store.changed(decodeURIComponent(changed))
    for (const {type, project, subject} of toldOf(response.headers.get('orrery-told'))) store.told(type, project, subject, actor)
    setResponseStatus(event, response.status)
    if (response.status === 204) return null
    setResponseHeader(event, 'Content-Type', 'application/json')
    return json
}
