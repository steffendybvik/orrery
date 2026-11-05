// The router in front of the Rust API (ORR-922, api/): with `apiUrl` and `apiToken` set, a request for a domain it serves
// goes there, after everything here has checked it as ever (auth, the board's permissions, the chat's and untrusted
// sessions' rails, the browser guards: the middleware before zz-api.ts). Both run on the same database, one writer per
// table, so while the API serves docs and the statuses nothing else here writes them except what it can't yet reach
// (the chat's doc requests, a board's upload or copy, deleting a project), which work on the same rows.
//
// It sends who's asking (`actorOf`) and which database this server is on, and the API's reply says what a write changed,
// which this tells as the store would: open pages read the project again, and the event log and schedules hear the event.
// When the API is down, or is on another database (the owner moved it), the request falls through to the routes here.
import {createHash} from 'node:crypto'
import type {H3Event} from 'h3'
import {createError, getCookie, getRequestHeader, getRequestURL, readRawBody, setResponseHeader, setResponseStatus} from 'h3'
import type {Actor} from '../store/schema'
import type {Who} from './auth'
import {loginCookie, toldOff} from './auth'
import {oidcOn} from './oidc'

/** The domains the Rust API serves, a line each (ORR-925): moving a domain there is adding its line once the parity test
 * passes, and taking it back to the routes here is taking the line out. Each matches a whole path after `/api/`, with no
 * slash at the end. A line with `methods` sends only those there, so a domain's reads can move before its writes
 * (`GET …/comments` before `POST …/comments`, ORR-927); one without takes every method its routes do. */
export const DOMAINS: readonly {domain: string, paths: RegExp, methods?: readonly string[]}[] = [
    // A project's docs, their revisions and sections (ORR-922). An artifact's page stays here: it's drawn with the
    // page's own sanitising and its locked-down headers (`artifact.get.ts`).
    {domain: 'docs', paths: /^projects\/[^/]+\/(docs(\/[^/]+(\/revisions(\/[^/]+(\/restore)?)?)?)?|deleted-docs|doc-sections(\/[^/]+)?)$/},
    // The orrery's issue statuses (ORR-926).
    {domain: 'statuses', paths: /^statuses(\/[^/]+)?$/},
    // A project's issues, read: the list with its filters, and one issue (ORR-927). Writing them stays here, as a change
    // wakes sessions (ORR-929).
    {domain: 'issues, reading', paths: /^projects\/[^/]+\/issues(\/[^/]+)?$/, methods: ['GET']},
    // An issue's comments, read (ORR-927). Writing one stays here until how a comment wakes sessions moves (ORR-929).
    {domain: 'comments, reading', paths: /^projects\/[^/]+\/issues\/[^/]+\/comments(\/[^/]+)?$/, methods: ['GET']},
    // A project's milestones and releases, read, and every project's releases (ORR-926). Writing them stays here, as
    // a milestone's or release's change is told to the event log and schedules (ORR-929).
    {domain: 'milestones and releases, reading', paths: /^(projects\/[^/]+\/(milestones|releases)(\/[^/]+)?|releases)$/, methods: ['GET']},
    // Who's on this orrery: listing, adding and renaming them, and inviting one (ORR-928). Removing a person stays here,
    // as it unassigns their issues, and an issue's change wakes sessions (ORR-929).
    {domain: 'people, but removing one', paths: /^people(\/[^/]+)?$/, methods: ['GET', 'POST', 'PATCH']},
    {domain: 'invites', paths: /^invites$/},
    // A person's keys and the browsers signed in as them (ORR-928). Checking a key or a login's cookie on each request,
    // and logging in and out, stay here (auth.ts): the API hears what that found (`whoHeaders`).
    {domain: 'keys', paths: /^keys(\/[^/]+)?$/},
    {domain: 'logins', paths: /^logins(\/[^/]+)?$/},
    // The orrery's secrets, read: never a value (ORR-953). Setting and narrowing one seal its value with the key, which
    // stays with the local app, and every write is told to the event log, so they and egress stay here.
    {domain: 'secrets, reading', paths: /^secrets(\/[^/]+)?$/, methods: ['GET']},
]

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** The domain whose line sends `method` on `path` (as `pathOf` gives it) to the Rust API, or undefined for the routes
 * here. A HEAD goes where its GET does. */
export function domainOf(method: string, path: string): string | undefined {
    const rest = /^\/api\/(.*?)\/?$/.exec(path)?.[1]
    if (rest === undefined) return undefined
    const asked = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
    return DOMAINS.find(({paths, methods}) => paths.test(rest) && (!methods || methods.includes(asked)))?.domain
}

/** Whether the Rust API serves `method` on `path`. */
export function servedByApi(method: string, path: string): boolean {
    return domainOf(method, path) !== undefined
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

/** What the auth middleware's credential said (`Who`), as the API reads it, and the asking browser's login hashed as the
 * logins table keeps it, so its cookie never leaves this server. Nothing with auth off. */
export function whoHeaders(who: Who | undefined, login: string | undefined): Record<string, string> {
    return {
        ...who ? {'Orrery-Who': who.via, 'Orrery-Who-Person': encodeURIComponent(who.person), 'Orrery-Who-Owner': who.owner ? '1' : '0'} : {},
        ...login ? {'Orrery-Login': createHash('sha256').update(login).digest('hex')} : {},
    }
}

/** What this server's settings say about getting in, which the API can't read: `provider` with a login provider set up
 * (`oidcOn`), `off` with ORRERY_AUTH=off; and the address the request came to, for an invite's link. */
export function loginHeaders(ways: {provider: boolean, off: boolean}, origin: string): Record<string, string> {
    const said = [...ways.provider ? ['provider'] : [], ...ways.off ? ['off'] : []]
    return {...said.length ? {'Orrery-Login-Ways': said.join(', ')} : {}, 'Orrery-Origin': encodeURIComponent(origin)}
}

/** The projects a reply's `Orrery-Changed` names: comma-separated, each percent-encoded (a status is every project's). */
export function changedOf(header: string | null): string[] {
    return header ? header.split(',').map(part => decodeURIComponent(part.trim())).filter(Boolean) : []
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
                ...whoHeaders(event.context.who as Who | undefined, getCookie(event, loginCookie(event))),
                ...loginHeaders({provider: oidcOn(), off: toldOff()}, getRequestURL(event, {xForwardedHost: true, xForwardedProto: true}).origin),
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
    for (const project of changedOf(response.headers.get('orrery-changed'))) store.changed(project)
    // The statuses are in the settings, which open pages get again (ORR-926).
    if (response.headers.get('orrery-settings') === '1') await store.settingsChanged()
    for (const {type, project, subject} of toldOf(response.headers.get('orrery-told'))) store.told(type, project, subject, actor)
    setResponseStatus(event, response.status)
    if (response.status === 204) return null
    setResponseHeader(event, 'Content-Type', 'application/json')
    return json
}
