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
import type {Feature} from '#shared/usage'
import type {Actor} from '../store/schema'
import type {Who} from './auth'
import {loginCookie, pathOf, toldOff} from './auth'
import {oidcOn} from './oidc'
import {countOwnUse} from './usage'

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
    // An issue's comments: reading, making and deleting one (ORR-927). The API's reply says what a new one leaves this
    // server to pass on to the sessions and the owner's bell (`handedOn`). Editing one stays here, as its route checks
    // the session's claim on the issue first (`claimFor`).
    {domain: 'comments, but editing one', paths: /^projects\/[^/]+\/issues\/[^/]+\/comments(\/[^/]+)?$/, methods: ['GET', 'POST', 'DELETE']},
    // Who changed what on an issue (ORR-927). Nothing writes it but the issue's own changes, which stay here (ORR-929).
    {domain: 'activity', paths: /^projects\/[^/]+\/issues\/[^/]+\/activity$/, methods: ['GET']},
    // A project's milestones, read (ORR-926) and written (ORR-974): the API tells what a write set off, as `Orrery-Told`,
    // and puts it in the outbox (ORR-929). A milestone's focus stays here, as it signals sessions.
    {domain: 'milestones', paths: /^projects\/[^/]+\/milestones(\/[^/]+)?$/},
    // A project's releases, read, and every project's (ORR-926), and a project's written, frozen and shipped (ORR-974):
    // what a write set off is told back, as `Orrery-Told`, and put in the outbox (ORR-929).
    {domain: 'releases', paths: /^projects\/[^/]+\/releases(\/[^/]+)?$/},
    {domain: 'releases, every project\'s', paths: /^releases$/, methods: ['GET']},
    // Who's on this orrery: listing, adding and renaming them, and inviting one (ORR-928). Removing a person stays here,
    // as it unassigns their issues, and an issue's change wakes sessions (ORR-929).
    {domain: 'people, but removing one', paths: /^people(\/[^/]+)?$/, methods: ['GET', 'POST', 'PATCH']},
    {domain: 'invites', paths: /^invites$/},
    // A person's keys and the browsers signed in as them (ORR-928). Checking a key or a login's cookie on each request,
    // and logging in and out, stay here (auth.ts): the API hears what that found (`whoHeaders`).
    {domain: 'keys', paths: /^keys(\/[^/]+)?$/},
    {domain: 'logins', paths: /^logins(\/[^/]+)?$/},
    // An image kept for Markdown, read (ORR-927). Keeping one stays here, as it's compressed here first.
    {domain: 'uploads, reading', paths: /^uploads\/[^/]+$/, methods: ['GET']},
    // The orrery's presets and a project's own (ORR-949). Seeding the ones orrery ships, as this server starts, stays here.
    {domain: 'presets', paths: /^(presets(\/[^/]+(\/reset)?)?|projects\/[^/]+\/presets)$/},
    // The orrery's secrets, read: never a value (ORR-953). Setting and narrowing one seal its value with the key, which
    // stays with the local app, and every write is told to the event log, so they and egress stay here.
    {domain: 'secrets, reading', paths: /^secrets(\/[^/]+)?$/, methods: ['GET']},
    // The orrery's stored settings, every one (ORR-954). What only this server knows is `GET /api/machine`, here. A
    // change's keys come back in `Orrery-Settings-Keys`, for the note in the event log the route here made.
    {domain: 'settings', paths: /^settings$/},
    // One pull request as orrery keeps it, read (ORR-952). The other pull reads ask GitHub when what's kept is stale,
    // which is the local app's to do, and the poll's writes wake sessions (ORR-929), so they stay here.
    {domain: 'a pull request, reading', paths: /^pulls\/[^/]+\/[^/]+\/[^/]+$/, methods: ['GET']},
    // Rating an issue's PR's risk (ORR-952): only its columns of `issue_pulls`, with the board told it changed. The poll
    // keeping a PR stays here, as a merge sets an issue's release and posts orrery's comments.
    {domain: "a pull request's risk", paths: /^projects\/[^/]+\/issues\/[^/]+\/pulls\/[^/]+\/[^/]+\/[^/]+\/risk$/, methods: ['PUT']},
    // The schedules, read (ORR-930): a project's, one with its runs, every project's and those across projects. Making,
    // changing and running them stays here, as a run starts a session and a write can set one off (ORR-929).
    {domain: 'schedules, reading', paths: /^(projects\/[^/]+\/schedules(\/[^/]+)?|schedules(\/across)?)$/, methods: ['GET']},
]

/** The headers a reply that isn't JSON keeps on its way through: what it is, how long the browser keeps it, and that
 * it's never run as a page. */
export const PASSED_HEADERS = ['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy'] as const

/** A successful reply that isn't JSON (an uploaded image, ORR-927), to send on as it came with the headers that say
 * what it is; undefined for JSON, and for a failure, which is thrown again here. */
export async function passedThrough(response: Response): Promise<{headers: Record<string, string>, body: Buffer} | undefined> {
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || !type || type.startsWith('application/json')) return undefined
    const headers = Object.fromEntries(PASSED_HEADERS.flatMap(name => {
        const value = response.headers.get(name)
        return value ? [[name, value]] : []
    }))
    return {headers, body: Buffer.from(await response.arrayBuffer())}
}

/** What a forwarded request counts toward the owner's own use of a feature (`countOwnUse`), as its route here did
 * before it moved: counted once the API has said yes. */
export const COUNTED: readonly {method: string, paths: RegExp, feature: Feature}[] = [
    {method: 'POST', paths: /^presets$/, feature: 'presets'},
    {method: 'POST', paths: /^projects\/[^/]+\/milestones$/, feature: 'milestones'},
]

/** The feature a successful `method` on `path` counts toward, if any. */
export function countedOf(method: string, path: string): Feature | undefined {
    const rest = /^\/api\/(.*?)\/?$/.exec(path)?.[1]
    return rest === undefined ? undefined : COUNTED.find(c => c.method === method.toUpperCase() && c.paths.test(rest))?.feature
}

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

/** The headers saying who's asking, as the API reads them: its name and session percent-encoded, as a header is ASCII,
 * and its kind as `kindOf` has it, as the chat and an untrusted session may name the owner (ORR-952). For the rails
 * between people (ORR-927), the member acting themselves (`person`), who it says it works for (`named`), and whether it
 * came from a request (`asked`). */
export function actorHeaders(actor: Actor): Record<string, string> {
    return {
        'Orrery-Actor-Name': encodeURIComponent(actor.name),
        'Orrery-Actor-Owner': actor.owner ? '1' : '0',
        'Orrery-Actor-Kind': actor.untrusted ? 'untrusted' : actor.chat ? 'chat' : actor.owner ? 'owner' : 'session',
        ...actor.session ? {'Orrery-Actor-Session': encodeURIComponent(actor.session)} : {},
        ...actor.person ? {'Orrery-Actor-Person': encodeURIComponent(actor.person)} : {},
        ...actor.named ? {'Orrery-Actor-Named': encodeURIComponent(actor.named)} : {},
        ...actor.asked ? {'Orrery-Actor-Asked': '1'} : {},
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

/** What a reply's `Orrery-Told` says happened: `<type> <project> <subject>, …`, each part percent-encoded, and after
 * them `<from> <to>` when a value changed, `~` for one that's none (ORR-927). */
export function toldOf(header: string | null): {type: string, project: string, subject: string, from?: string | null, to?: string | null}[] {
    if (!header) return []
    return header.split(',').map(part => part.trim().split(' ')).filter(parts => parts.length === 3 || parts.length === 5)
        .map(([type = '', project = '', subject = '', ...change]) => {
            const [from, to] = change.map(value => value === '~' ? null : decodeURIComponent(value))
            return {type: decodeURIComponent(type), project: decodeURIComponent(project), subject: decodeURIComponent(subject), ...change.length ? {from, to} : {}}
        })
}

/** What a new comment's reply leaves this server to do (ORR-927): `Orrery-Carry` and `Orrery-Notice`, each
 * `<project> <issue> <comment>` percent-encoded, to pass it on to the session on its issue and to the owner's bell. */
export function handedOn(headers: Headers): {project: string, issue: string, comment: number, carry: boolean, notice: boolean} | undefined {
    const said = headers.get('orrery-carry') ?? headers.get('orrery-notice')
    const [project, issue, comment] = said?.trim().split(' ').map(decodeURIComponent) ?? []
    if (!project || !issue || !Number.isInteger(Number(comment))) return undefined
    return {project, issue, comment: Number(comment), carry: headers.has('orrery-carry'), notice: headers.has('orrery-notice')}
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
    const passed = await passedThrough(response)
    if (passed) {
        setResponseStatus(event, response.status)
        for (const [name, value] of Object.entries(passed.headers)) setResponseHeader(event, name, value)
        return passed.body
    }
    const text = await response.text()
    const json = text ? JSON.parse(text) as Record<string, unknown> : null
    if (response.status >= 400) {
        throw createError({statusCode: response.status, statusMessage: String(json?.statusMessage ?? ''), message: String(json?.message ?? ''), ...json?.data === undefined ? {} : {data: json.data}})
    }
    const store = useStore()
    // The API put what it set off in the outbox already, so the store's hooks don't again (ORR-929).
    await store.relaying(async () => {
        for (const project of changedOf(response.headers.get('orrery-changed'))) store.changed(project)
        // The statuses are in the settings, which open pages get again (ORR-926).
        if (response.headers.get('orrery-settings') === '1') await store.settingsChanged()
        const keys = changedOf(response.headers.get('orrery-settings-keys'))
        if (keys.length) useEventLog().note({level: 'info', kind: 'settings.changed', message: `${actor.name} changed the settings: ${keys.join(', ')}`, details: {by: actor.name, keys}})
        for (const {type, project, subject, from, to} of toldOf(response.headers.get('orrery-told'))) store.told(type, project, subject, actor, {from, to})
    })
    // Outside `relaying`: the signal and the bell's notice are this server's own, with their own rows in the outbox.
    const handoff = handedOn(response.headers)
    if (handoff) await store.handOn(handoff.project, handoff.issue, handoff.comment, handoff, actor)
    const counted = countedOf(event.method, pathOf(event))
    if (counted) countOwnUse(event, counted)
    setResponseStatus(event, response.status)
    if (response.status === 204) return null
    setResponseHeader(event, 'Content-Type', 'application/json')
    return json
}
