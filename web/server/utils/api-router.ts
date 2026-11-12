// The router in front of the Rust API (ORR-922, api/): with `apiUrl` and `apiToken` set, a request for a domain it serves
// goes there, after everything here has checked it as ever (auth, the board's permissions, the chat's and untrusted
// sessions' rails, the browser guards: the middleware before zz-api.ts). Both run on the same database, one writer per
// table, so while the API serves docs and the statuses nothing else here writes them except what it can't yet reach
// (the chat's doc requests, a board's upload or copy), which work on the same rows.
//
// It sends who's asking (`actorOf`) and which database this server is on, and the API's reply says what a write changed,
// which this tells as the store would: open pages read the project again, and the event log and schedules hear the event.
// When the API is down, or is on another database (the owner moved it), the request fails, and says why in the log: the
// routes it serves are its alone (ORR-1091).
import {createHash} from 'node:crypto'
import type {H3Event} from 'h3'
import {createError, getCookie, getQuery, getRequestHeader, getRequestHost, getRequestURL, readRawBody, setResponseHeader, setResponseStatus} from 'h3'
import type {Feature} from '#shared/usage'
import type {Actor} from '../store/schema'
import type {Who} from './auth'
import {bearer, loginCookie, onLoopback, pathOf, toldOff, toldOn} from './auth'
import {proxied} from './move'
import {viaPhone} from './phone-port'
import {caughtUp, followingOutbox} from './outbox-follower'
import {oidcOn} from './oidc'
import {countOwnUse, dropGathered, flushUse, usageAllowed} from './usage'
import {startsNone} from './starts-none'
import {revLabel} from './events'
import type {Project} from '#shared/roadmap'
import {withoutClosed, withoutNotes} from '#shared/patch'

/** The domains the Rust API serves, a line each (ORR-925): moving a domain there is adding its line once the parity test
 * passes, and taking it back to the routes here is taking the line out. Each matches a whole path after `/api/`, with no
 * slash at the end. A line with `methods` sends only those there, so a domain's reads can move before its writes
 * (`GET …/comments` before `POST …/comments`, ORR-927); one without takes every method its routes do.
 *
 * Each line's domain is the API's alone: with the API down, or not set up, a request for it fails (`cantReach`). Only a
 * line with `here` still has its route here, for the requests its `first` check keeps (a session's, the chat's). */
export const DOMAINS: readonly {domain: string, paths: RegExp, methods?: readonly string[], first?: Partial<Record<string, LocalCheck>>, reply?: Partial<Record<string, Shaping>>, here?: true}[] = [
    // A project's docs, their revisions and sections (ORR-922). An artifact's page stays here: it's drawn with the
    // page's own sanitising and its locked-down headers (`artifact.get.ts`).
    {domain: 'docs', paths: /^projects\/[^/]+\/(docs(\/[^/]+(\/revisions(\/[^/]+(\/restore)?)?)?)?|deleted-docs|doc-sections(\/[^/]+)?)$/},
    // The orrery's issue statuses (ORR-926).
    {domain: 'statuses', paths: /^statuses(\/[^/]+)?$/},
    // What each kind of session may do (ORR-1086): the table in shared/permissions.ts, as api/permissions.json holds it.
    {domain: 'permissions', paths: /^permissions$/, methods: ['GET']},
    // A project's issues, read: the list with its filters, and one issue (ORR-927). Writing them stays here, as a change
    // wakes sessions (ORR-929).
    {domain: 'issues, reading', paths: /^projects\/[^/]+\/issues(\/[^/]+)?$/, methods: ['GET']},
    // An issue's comments: reading, making, editing and deleting one (ORR-927). The API's reply says what a new or
    // edited one leaves this server to pass on to the sessions and the owner's bell (`handedOn`). An edit checks the
    // session's claim on the issue here first, as only this server knows the sessions (`claimFor`, ORR-627).
    {domain: 'comments', paths: /^projects\/[^/]+\/issues\/[^/]+\/comments(\/[^/]+)?$/, first: {PATCH: claimOnComment}},
    // Deleting an issue, with its sub-issues and comments, or many at once (`{ids}`, ORR-927): the API tells each back,
    // and the dependents it frees, as `Orrery-Told`, and puts them in the outbox (ORR-929).
    {domain: 'an issue, deleted', paths: /^projects\/[^/]+\/issues(\/[^/]+)?$/, methods: ['DELETE']},
    // Changing an issue (ORR-927): its title, status, priority, assignee, notes, labels, tasks, GitHub issues, parent,
    // milestone, release, epic, what it depends on, whether it's a proposal and its choices, model, effort and place. One
    // it makes urgent comes back with `Orrery-Urgent`, for the push here (`sayUrgent`). Moving it to another project stays
    // here (`wordsOnly`), and so does a session's change of its status, as the session's lock on the issue is this
    // server's (`claimed`). The chat's rails and a session's claim are checked here first.
    // Making an issue (ORR-927): one that names nothing but an issue's words (`onlyWords`). The API rewrites the chat's
    // and an untrusted session's asks itself (`asChatIssue`, `asProposal`, ORR-1059), and notes a session's issue as its
    // work (`workedOn`), told what only this server knows (`askerHeaders`). One that's urgent comes back with
    // `Orrery-Urgent`, for the push here.
    {domain: 'an issue, made', paths: /^projects\/[^/]+\/issues$/, methods: ['POST'], first: {POST: newWordsOnly}, here: true},
    {domain: 'an issue, its words', paths: /^projects\/[^/]+\/issues\/[^/]+$/, methods: ['PATCH'], first: {PATCH: wordsOnly}, here: true},
    // One change to many issues (`{ids, set, labels}`, ORR-927): each edited as one is, the route here taking no session's
    // lock or chat's rewrite for it either. The ones it makes urgent come back in `Orrery-Urgent`, for the push here.
    {domain: 'issues, changed at once', paths: /^projects\/[^/]+\/issues$/, methods: ['PATCH']},
    // The owner's decision on a proposal (ORR-927): its comment comes back as `Orrery-Carry`, marked ` quiet` for a
    // rejection, which is passed on to the session here but starts no work (`startsNone`, ORR-606).
    // Many at once (`{ids, decision, note?}`) come back with a carry each, apart by commas.
    {domain: 'a proposal, decided', paths: /^projects\/[^/]+\/issues(\/[^/]+)?\/decide$/, methods: ['POST']},
    // Taking an issue up and letting it go (ORR-927, ORR-657): the API tells the claim and a new assignee back, as
    // `Orrery-Told`, and puts them in the outbox (ORR-929).
    {domain: 'claims', paths: /^projects\/[^/]+\/issues\/[^/]+\/claim$/},
    // Who changed what on an issue (ORR-927). Its claims are written there (`claims`), and the issue's other changes stay here (ORR-929).
    {domain: 'activity', paths: /^projects\/[^/]+\/issues\/[^/]+\/activity$/, methods: ['GET']},
    // A project's milestones, read (ORR-926) and written (ORR-974): the API tells what a write set off, as `Orrery-Told`,
    // and puts it in the outbox (ORR-929). A milestone's focus stays here, as it signals sessions.
    {domain: 'milestones', paths: /^projects\/[^/]+\/milestones(\/[^/]+)?$/},
    // A project's releases, read, and every project's (ORR-926), and a project's written, frozen and shipped (ORR-974):
    // what a write set off is told back, as `Orrery-Told`, and put in the outbox (ORR-929).
    {domain: 'releases', paths: /^projects\/[^/]+\/releases(\/[^/]+)?$/},
    {domain: 'releases, every project\'s', paths: /^releases$/, methods: ['GET']},
    // Who's on this orrery: listing, adding, renaming and removing them, and inviting one (ORR-928). Removing one
    // unassigns their open issues, each told back as `Orrery-Told` and put in the outbox (ORR-929).
    {domain: 'people', paths: /^people(\/[^/]+)?$/, methods: ['GET', 'POST', 'PATCH', 'DELETE']},
    {domain: 'invites', paths: /^invites$/},
    // A person's keys and the browsers signed in as them (ORR-928). Checking a key or a login's cookie on each request,
    // and logging in and out, stay here (auth.ts): the API hears what that found (`whoHeaders`).
    {domain: 'keys', paths: /^keys(\/[^/]+)?$/},
    {domain: 'logins', paths: /^logins(\/[^/]+)?$/},
    // An image kept for Markdown, read (ORR-927), and kept, compressed in Rust as compress.ts does here (ORR-1058).
    {domain: 'uploads, reading', paths: /^uploads\/[^/]+$/, methods: ['GET']},
    {domain: 'an upload, kept', paths: /^uploads$/, methods: ['POST']},
    // The orrery's presets and a project's own (ORR-949). Seeding the ones orrery ships (`presets/seed`, ORR-1136) is
    // this server's own call to the API as it starts, so it isn't sent on from outside.
    {domain: 'presets', paths: /^(presets(\/(?!seed$)[^/]+(\/reset)?)?|projects\/[^/]+\/presets)$/},
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
    // Of the writes (ORR-950): adopting an agent's schedule and deleting one, neither of which starts a session.
    {domain: 'a schedule, adopted', paths: /^projects\/[^/]+\/schedules\/[^/]+\/adopt$/, methods: ['POST']},
    {domain: 'a schedule, deleted', paths: /^projects\/[^/]+\/schedules\/[^/]+$/, methods: ['DELETE']},
    // Changing one (ORR-1082): it works out its next run again, and starts no session.
    {domain: 'a schedule, changed', paths: /^projects\/[^/]+\/schedules\/[^/]+$/, methods: ['PATCH']},
    // Making one (ORR-1082): it works out its first run, and starts no session.
    {domain: 'a schedule, made', paths: /^projects\/[^/]+\/schedules$/, methods: ['POST']},
    // Deleting one across projects (ORR-1082), with the schedules made from it: it starts no session.
    {domain: 'a schedule across projects, deleted', paths: /^schedules\/across\/[^/]+$/, methods: ['DELETE']},
    // Pausing or activating all of a project's (ORR-1082): it works out each next run, and starts no session.
    {domain: 'schedules, paused or activated', paths: /^projects\/[^/]+\/schedules\/enabled$/, methods: ['POST']},
    // A working session asking the owner for a schedule on its issue (ORR-1100): a comment with the request beside it,
    // checked as Schedules would check it, saving nothing. Its claim on the issue is checked here first (`claimFor`), and
    // the event log's line comes back as `Orrery-Asked`.
    {domain: 'a schedule, asked for', paths: /^projects\/[^/]+\/issues\/[^/]+\/schedule-requests$/, methods: ['POST'], first: {POST: claimOnComment}},
    // The owner's Allow or Deny of it (ORR-1100): the schedule made or changed as theirs, and their answer a comment
    // handed on quietly. The event log's line comes back as `Orrery-Answered`.
    {domain: 'a schedule, answered', paths: /^projects\/[^/]+\/issues\/[^/]+\/schedule-requests\/[^/]+$/, methods: ['POST']},
    // A project's signals, read (ORR-1087): after an id, or the latest about an issue or milestone. Their delivery, the
    // stream and the listeners stay here, as they set what each session is doing.
    {domain: 'signals, reading', paths: /^projects\/[^/]+\/signals$/, methods: ['GET']},
    // Every project, listed with its counts (ORR-997). With `?expand=board` it's their boards (ORR-1006), each labelled
    // here with the events stream's `rev`, as one project's read is (`boardsWithRev`).
    {domain: 'projects, listed', paths: /^projects$/, methods: ['GET'], reply: {GET: boardsWithRev}},
    // Making a project (ORR-1002), held by whoever asks, as `personOf` has it here. The reply is the project with its
    // board, without the `rev` that reading one adds here.
    {domain: 'a project, made', paths: /^projects$/, methods: ['POST']},
    // Changing a project (ORR-923): its name, key, icon, prompts, repo and where its releases come from. The reply is the
    // project with its board, without the `rev` that reading one adds here.
    {domain: 'a project, changed', paths: /^projects\/[^/]+$/, methods: ['PATCH']},
    // Reading a project with its board (ORR-1006). The `rev` the page's patches build on is this server's, so the reply
    // is labelled here with it, as it was before the read (`withRev`).
    {domain: 'a project, read', paths: /^projects\/[^/]+$/, methods: ['GET'], reply: {GET: withRev}},
    // Deleting a project (ORR-1006), with everything in it: its schedules too, told back as `Orrery-Schedules` for the
    // runner here to drop, and its signals, which are only rows.
    {domain: 'a project, deleted', paths: /^projects\/[^/]+$/, methods: ['DELETE']},
    // A board as one file (ORR-1006): read in one transaction, named for the project and the day (`Content-Disposition`).
    // Whether the asker is on the board is checked here first (`needsBoard`), as a write's board is in middleware/board.ts.
    {domain: 'a project, exported', paths: /^projects\/[^/]+\/export$/, methods: ['GET'], first: {GET: onTheBoard}},
    // A roadmap in `docs/roadmap.json`'s format, imported into a project (ORR-1006): its milestones and issues, given the
    // project's ids, the file's kept as aliases; `?replace=true` clears what was there first.
    {domain: 'a project, imported', paths: /^projects\/[^/]+\/import$/, methods: ['POST']},
    // The bell (ORR-1005): agents' comments across projects with the proposals waiting on the owner, the status changes
    // on their issues, and clearing them or marking them read, each person's their own (ORR-658). Clearing tells nothing:
    // the page that did it reads the bell again.
    // The owner's feature counts (ORR-1089): read with what's gathered in memory here written first, and `allowed`, the
    // server's own setting (`ORRERY_USAGE`), added to the reply; forgotten with what's gathered dropped first, when it's
    // the owner asking. Counting a use stays here (`POST`), in memory, and is sent on once a minute (`flushUse`).
    // The event log, read, and a line in it resolved with its repeats (ORR-1088). Each line a resolve changed comes back
    // through the outbox (`event.logged`) for open pages' bells. A page's error report (`POST`) stays here, as each
    // sender is counted in memory; the line it makes, scrubbed of secrets' values, goes on as this server's own do
    // (`EventLog.keep`, `PUT /api/events/log/lines`).
    {domain: 'the event log, read', paths: /^events\/log$/, methods: ['GET']},
    {domain: 'an event, resolved', paths: /^events\/log\/[^/]+\/resolve$/, methods: ['POST']},
    {domain: 'usage', paths: /^usage$/, methods: ['GET', 'DELETE'], first: {GET: async () => await flushUse(), DELETE: dropForOwner}, reply: {GET: withAllowed}},
    {domain: 'the bell', paths: /^notices(\/(changes|clear|read))?$/},
    // The epics (ORR-1004): every one with its progress, one with its issues, and making, changing and deleting one. A
    // write's reply says the epics changed (`Orrery-Epics`), for open pages to ask for them again. An epic's focus, which
    // signals sessions, stays here.
    {domain: 'epics', paths: /^epics(\/[^/]+)?$/},
    // A milestone's comments and an epic's (ORR-1004): words on its page, which ask nothing and wake no session. A write
    // says the milestone's project changed, or the epics did (`Orrery-Epics`).
    {domain: 'milestone and epic comments', paths: /^(projects\/[^/]+\/milestones|epics)\/[^/]+\/comments(\/[^/]+)?$/},
]

/** What this server does to a reply from the API, as only it knows it, taken before the request goes on: the path to ask
 * instead, and what to make of the reply's JSON when it succeeds. */
type Shaping = (event: H3Event) => {path?: string, reply: (json: unknown) => unknown} | undefined

/** A board read labelled with the events stream's `rev` as it is before the read (`revLabel`, ORR-482). The API is
 * asked for every issue, as a board never read before is kept as the base its first patch is made from, and its
 * closed issues are left out here once that's kept, as the route here does (`?closed=0`). */
export function withRev(event: H3Event): NonNullable<ReturnType<Shaping>> {
    const label = revLabel()
    const query = getQuery(event)
    return {
        path: without(event.path, ['closed']),
        reply: json => {
            const project = label(json as Project)
            const lighter = query.notes === '0' ? withoutNotes(project) : project
            return query.closed === '0' ? withoutClosed(lighter) : lighter
        },
    }
}

/** Every project's board (`?expand=board`), each labelled as `withRev` labels one, and asked for whole the same way:
 * the closed issues are left out here, but for the projects in `&whole=`. Without `expand=board` it's the counts, as
 * they came. */
export function boardsWithRev(event: H3Event): ReturnType<Shaping> {
    const query = getQuery(event)
    if (query.expand !== 'board') return undefined
    const label = revLabel()
    const whole = new Set(typeof query.whole === 'string' ? query.whole.split(',') : [])
    return {
        path: without(event.path, ['closed', 'whole']),
        reply: json => (json as Project[]).map(label).map(board => {
            const lighter = query.notes === '0' ? withoutNotes(board) : board
            return query.closed === '0' && !whole.has(board.id) ? withoutClosed(lighter) : lighter
        }),
    }
}

/** The feature counts with `allowed`, the server's own setting, put in as the route here had it: `{on, allowed, features}`. */
function withAllowed(): ReturnType<Shaping> {
    return {reply: json => {
        const {on, features} = json as {on: boolean, features: unknown[]}
        return {on, allowed: usageAllowed(), features}
    }}
}

/** What's gathered here dropped before the owner forgets every count; anyone else is refused by the API, so it's kept. */
async function dropForOwner(event: H3Event) {
    if ((await actorOf(event)).owner) dropGathered()
}

/** The path with these query parameters left out. */
function without(asked: string, names: string[]): string {
    const [path = '', search = ''] = asked.split('?')
    const params = new URLSearchParams(search)
    for (const name of names) params.delete(name)
    const kept = params.toString()
    return kept ? `${path}?${kept}` : path
}

/** What this server checks itself before a request goes on, as only it knows (the sessions): refusing it throws, and
 * `'here'` keeps it for the routes here, for what the API doesn't do yet. */
type LocalCheck = (event: H3Event, rest: string) => Promise<unknown>

/** The fields of an issue's edit the API changes (`api/src/board/issue_edits.rs`, `WORDS`). */
const ISSUE_WORDS: readonly string[] = ['title', 'status', 'plan', 'priority', 'assignee', 'labels', 'external', 'github_issues', 'notes', 'proposal', 'choices', 'parent', 'milestone', 'release', 'epic', 'depends_on', 'model', 'effort', 'position']

/** Whether an issue's edit names only its own words, so the API can make it: a body that isn't an object, or is
 * empty, stays here too, for its answer. */
export function onlyWords(body: unknown): boolean {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return false
    const keys = Object.keys(body)
    return keys.length > 0 && keys.every(key => ISSUE_WORDS.includes(key))
}

/** Whether an edit changes the issue's status (`status`, or the old `plan`). */
export function movesStatus(body: unknown): boolean {
    return typeof body === 'object' && body !== null && ('status' in body || 'plan' in body)
}

/** An issue's edit, kept here unless it names only its words (`onlyWords`), and a session's here too when it changes the
 * status: starting one takes the session's lock on it, which only this server holds (`claimed`). One that goes on is
 * the chat's only within what it may change (`asChatEdit`), and a session's only while no other session is on the
 * issue (`claimFor`), as the route here has them. */
async function wordsOnly(event: H3Event, rest: string) {
    const raw = await readRawBody(event, 'utf8')
    let body: unknown
    try {
        body = raw ? JSON.parse(raw) : undefined
    } catch {
        return 'here' as const
    }
    if (!onlyWords(body)) return 'here' as const
    if (chatWrite(event)) {
        asChatEdit(body)
        return
    }
    if (movesStatus(body) && sessionHeader(event) && !(await actorOf(event)).owner) return 'here' as const
    const [, project, issue] = /^projects\/([^/]+)\/issues\/([^/]+)$/.exec(rest) ?? []
    if (project && issue) await claimFor(event, decodeURIComponent(project), decodeURIComponent(issue))
}

/** A new issue, kept here unless it names only an issue's words. An untrusted session's always goes on, as the API
 * keeps only its words (`asProposal`). */
async function newWordsOnly(event: H3Event) {
    if (untrustedWrite(event)) return
    const raw = await readRawBody(event, 'utf8')
    try {
        if (!onlyWords(raw ? JSON.parse(raw) : undefined)) return 'here' as const
    } catch {
        return 'here' as const
    }
}


/** A read refused to a person off the project's board, as if it weren't there (`needsBoard`). */
async function onTheBoard(event: H3Event, rest: string) {
    const [, project] = /^projects\/([^/]+)\//.exec(rest) ?? []
    if (project) await needsBoard(event, decodeURIComponent(project))
}

/** A comment's edit, refused while another session is working on its issue (ORR-627), as its route here does. */
async function claimOnComment(event: H3Event, rest: string) {
    const [, project, issue] = /^projects\/([^/]+)\/issues\/([^/]+)\//.exec(rest) ?? []
    if (project && issue) await claimFor(event, decodeURIComponent(project), decodeURIComponent(issue))
}

/** The headers a reply that isn't JSON keeps on its way through: what it is, how long the browser keeps it, and that
 * it's never run as a page. */
const PASSED_HEADERS = ['content-type', 'cache-control', 'x-content-type-options', 'content-security-policy'] as const

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
const COUNTED: readonly {method: string, paths: RegExp, feature: Feature}[] = [
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
    return lineOf(method, path)?.line.domain
}

/** The line that sends `method` on `path` to the Rust API, with the path after `/api/`. */
function lineOf(method: string, path: string): {line: typeof DOMAINS[number], rest: string} | undefined {
    const rest = /^\/api\/(.*?)\/?$/.exec(path)?.[1]
    if (rest === undefined) return undefined
    const asked = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
    const line = DOMAINS.find(({paths, methods}) => paths.test(rest) && (!methods || methods.includes(asked)))
    return line && {line, rest}
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

/** What only this server knows of who's asking, for the API's rewrite of a new issue (ORR-1059): the status the owner
 * picked for the chat's issues (`Orrery-Chat-Issues`) and which chat it is (`Orrery-Launch`), or the session a write is noted as worked by, by the id it goes
 * by after a `/clear` (`Orrery-Worked-By`, percent-encoded). An untrusted session's is never the chat's. */
export function askerHeaders(event: H3Event, actor: Actor): Record<string, string> {
    if (actor.chat && !actor.untrusted) {
        // And which chat it is (`Orrery-Launch`, its launch's id), for the asks `/mcp` keeps in it (ORR-1100).
        const launch = getHeader(event, 'orrery-launch')?.trim()
        return {'Orrery-Chat-Issues': chatIssuesFor(launch), ...launch ? {'Orrery-Launch': encodeURIComponent(launch)} : {}}
    }
    const session = getHeader(event, 'orrery-session')?.trim()
    return session ? {'Orrery-Worked-By': encodeURIComponent(currentId(session))} : {}
}

/** What the auth middleware's credential said (`Who`), and the credential itself, hashed as the logins and keys tables
 * keep them, so a cookie or key never leaves this server: the asking browser's login, and the bearer (`Orrery-Key`).
 * The API checks the credential again for itself (ORR-1038), and goes by what it finds, not by `Orrery-Who`. With it, what
 * the API's guard checks again (ORR-1081): the request's own `Origin`, as `Orrery-Sent-Origin` (`Orrery-Origin` is the
 * address it came to), and the session it names (`Orrery-Session`), both percent-encoded. */
export function whoHeaders(who: Who | undefined, login: string | undefined, key?: string, sent: {origin?: string, session?: string} = {}): Record<string, string> {
    const hashed = (secret: string) => createHash('sha256').update(secret).digest('hex')
    return {
        ...sent.origin ? {'Orrery-Sent-Origin': encodeURIComponent(sent.origin)} : {},
        ...sent.session ? {'Orrery-Session': encodeURIComponent(sent.session)} : {},
        ...who ? {'Orrery-Who': who.via, 'Orrery-Who-Person': encodeURIComponent(who.person), 'Orrery-Who-Owner': who.owner ? '1' : '0'} : {},
        ...login ? {'Orrery-Login': hashed(login)} : {},
        ...key ? {'Orrery-Key': hashed(key)} : {},
    }
}

/** Said on a call this server makes for its own work (`writeToApi`, the outbox's follower), which no outside request set
 * off: the API checks no login for it, and takes who it says it's for (ORR-1038). Only a holder of the token sends it. */
export const OWN_WORK = {'Orrery-Came': 'server'} as const

/** What this server's settings say about getting in, which the API can't read: `provider` with a login provider set up
 * (`oidcOn`), `off` with ORRERY_AUTH=off, `on` with ORRERY_AUTH=on; and the address the request came to, for an
 * invite's link. */
export function loginHeaders(ways: {provider: boolean, off: boolean, on?: boolean}, origin: string): Record<string, string> {
    const said = [...ways.provider ? ['provider'] : [], ...ways.off ? ['off'] : [], ...ways.on ? ['on'] : []]
    return {...said.length ? {'Orrery-Login-Ways': said.join(', ')} : {}, 'Orrery-Origin': encodeURIComponent(origin)}
}

/** How the request reached this server, which only its socket knows (ORR-928), for the API's `authMode`: `loopback`
 * (`onLoopback`), `proxied`, `phone` (the phone's own port, `viaPhone`) and `https` (`overHttps`), any of them; and
 * the host it asked for, as `Orrery-Host`, for the login page's plain-http warning. */
export function cameHeaders(came: {loopback: boolean, proxied: boolean, phone: boolean, https: boolean}, host: string): Record<string, string> {
    const said = (['loopback', 'proxied', 'phone', 'https'] as const).filter(how => came[how])
    return {...said.length ? {'Orrery-Came': said.join(', ')} : {}, 'Orrery-Host': encodeURIComponent(host)}
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

/** What a new or edited comment's reply leaves this server to do (ORR-927): `Orrery-Carry` and `Orrery-Notice`, each
 * `<project> <issue> <comment>` percent-encoded, to pass it on to the session on its issue and to the owner's bell; an
 * edit's carry ends ` edited`, as its words replace ones the session may have read, and a rejection's ` quiet`, as it
 * starts no work (`startsNone`). Many decisions at once say many, apart by commas, in the order they were made. */
export function handoffsOf(headers: Headers): {project: string, issue: string, comment: number, carry: boolean, notice: boolean, edited: boolean, quiet: boolean}[] {
    const all = new Map<string, {project: string, issue: string, comment: number, carry: boolean, notice: boolean, edited: boolean, quiet: boolean}>()
    for (const header of ['orrery-carry', 'orrery-notice'] as const) {
        for (const one of (headers.get(header) ?? '').split(',')) {
            const [project, issue, comment, mark] = one.trim().split(' ').map(decodeURIComponent)
            if (!project || !issue || !Number.isInteger(Number(comment))) continue
            const key = `${project} ${issue} ${comment}`
            const said = all.get(key) ?? {project, issue, comment: Number(comment), carry: false, notice: false, edited: mark === 'edited', quiet: mark === 'quiet'}
            said[header === 'orrery-carry' ? 'carry' : 'notice'] = true
            all.set(key, said)
        }
    }
    return [...all.values()]
}

/** The one comment a reply hands on (`handoffsOf`), if it does. */
export function handedOn(headers: Headers) {
    return handoffsOf(headers)[0]
}

/** Passes a comment the API made on to the session and the bell, as `handedOn` read it: a quiet one starts no work. */
export async function handOn(store: Pick<ReturnType<typeof useStore>, 'handOn'>, handoff: ReturnType<typeof handoffsOf>[number], actor: Actor) {
    const pass = () => store.handOn(handoff.project, handoff.issue, handoff.comment, handoff, actor)
    await (handoff.quiet ? startsNone.run(true, pass) : pass())
}

/** A session's ask for a schedule, as its reply says it (`Orrery-Asked`: `<project> <issue> <schedule or -> <fields>
 * <line>`, each percent-encoded, the fields apart by commas), for the event log's line (ORR-1100). */
function askedOf(header: string | null): {project: string, issue: string, schedule: number | null, fields: string[], line: string} | undefined {
    const [project, issue, schedule, fields, line, ...rest] = (header ?? '').trim().split(' ').map(decodeURIComponent)
    if (!project || !issue || !schedule || fields === undefined || !line || rest.length) return undefined
    return {project, issue, schedule: schedule === '-' ? null : Number(schedule), fields: fields ? fields.split(',') : [], line}
}

/** The owner's answer to a session's ask for a schedule, as its reply says it (`Orrery-Answered`: `<project> <issue>
 * <schedule or -> <fields> <allowed or denied> <line>`, each percent-encoded), for the event log's line (ORR-1100). */
function answeredOf(header: string | null): {project: string, issue: string, schedule: number | null, fields: string[], how: 'allowed' | 'denied', line: string} | undefined {
    const [project, issue, schedule, fields, how, line, ...rest] = (header ?? '').trim().split(' ').map(decodeURIComponent)
    if (!project || !issue || !schedule || fields === undefined || (how !== 'allowed' && how !== 'denied') || !line || rest.length) return undefined
    return {project, issue, schedule: schedule === '-' ? null : Number(schedule), fields: fields ? fields.split(',') : [], how, line}
}

/** The issues an edit's reply says it made urgent open work (`Orrery-Urgent`, `<project> <issue>` percent-encoded, many
 * apart by commas), for the push to the sessions only this server can make (`sayUrgent`, ORR-927). */
export function urgentOf(header: string | null): {project: string, issue: string}[] {
    return (header ?? '').split(',').flatMap(one => {
        const [project, issue, ...rest] = one.trim().split(' ').map(decodeURIComponent)
        return project && issue && !rest.length ? [{project, issue}] : []
    })
}

/** The API this server started itself (`plugins/api.ts`), once it's listening. */
let started: {url: string, token: string} | null = null
/** Who hears each time the API this server started begins listening: at boot, and again after a move (ORR-1035). */
const whenStarted = new Set<() => void>()

export function apiStarted(api: {url: string, token: string} | null) {
    started = api
    if (api) apiStarting(false)
    if (api) for (const heard of [...whenStarted]) heard()
}

/** Calls `heard` each time the API this server starts begins listening; gives back what stops it. */
export function onApiStarted(heard: () => void): () => void {
    whenStarted.add(heard)
    return () => void whenStarted.delete(heard)
}

/** Whether this server is starting the API now (at boot, or again after a move, ORR-1035), and who waits for it. */
let starting = false
const listening = new Set<() => void>()

/** Whether this server has started the API at all: from then on its own writes are the API's alone (`writeToApi`). */
let meant = false

export function apiStarting(value: boolean) {
    starting = value
    if (value) meant = true
    if (!value) for (const done of [...listening]) done()
}

/** Forgets that this server ever started the API, for tests. */
export function apiForgotten() {
    meant = false
}

/** Resolves once the API this server is starting listens, or gives up starting, `within` ms at most; at once when it's
 * listening already or nothing is starting it. */
export function apiListening(within = 5000): Promise<void> {
    if (started || !starting) return Promise.resolve()
    return new Promise(resolve => {
        const timer = setTimeout(done, within)
        function done() {
            clearTimeout(timer)
            listening.delete(done)
            resolve()
        }
        listening.add(done)
    })
}

/** Where the API is, and its token: the one this server started, or the one the settings name; none, no API. */
export function apiTarget(config: {apiUrl?: unknown, apiToken?: unknown}): {url: string, token: string} | null {
    if (started) return started
    return config.apiUrl && config.apiToken ? {url: String(config.apiUrl), token: String(config.apiToken)} : null
}

/** Why the API last couldn't answer, said once, not on every request, until it answers again. */
let unreachable = ''

/** The API can't answer `event` (`why`): a 503 that says why, logged once to the server's log and the event log while
 * it lasts. */
function cantReach(event: H3Event | string, why: string, reason: Reason = 'unreachable'): never {
    const again = unreachable === why
    unreachable = why
    servedHere(event, reason)
    const asked = typeof event === 'string' ? event : `${event.method} ${pathOf(event, true)}`
    const message = `The Rust API ${why}, so this server can't answer ${asked}: its routes are the API's alone.`
    if (!again) {
        console.error(`[orrery] ${message}`)
        useEventLog().note({level: 'error', kind: 'api.unreachable', message, details: {why}})
    }
    throw createError({statusCode: 503, statusMessage: 'The Rust API can\'t be reached', message})
}

/** The header every reply to an `/api/` request carries, saying which server answered it (ORR-1085): `rust` for one the
 * API answered (its refusals too), `nuxt` for the rest, so it shows in the browser's network tab. */
export const SERVED_BY = 'X-Served-By'

/** Why a request the API serves (`DOMAINS`) wasn't answered there, as `servedHere` logs it. */
export type Reason = 'not-running' | 'unreachable' | 'other-database' | 'kept-here'

/** Logs a request the API serves that it didn't answer (ORR-1085), one line each, key=value after a fixed prefix, so
 * `play logs | grep 'orrery api-route'` finds them: `served=nuxt` when a line's check kept it for the routes here,
 * `served=none` when it failed. */
function servedHere(event: H3Event | string, reason: Reason, check?: string) {
    const only = reason !== 'kept-here'
    const [method = '', path = ''] = typeof event === 'string' ? event.split(' ', 2) : [event.method, pathOf(event, true)]
    const domain = domainOf(method, (path.split('?')[0] ?? '').toLowerCase()) ?? ''
    const line = `[orrery api-route] served=${only ? 'none' : 'nuxt'} reason=${reason}${check ? ` check=${check}` : ''} domain=${JSON.stringify(domain)} method=${method.toUpperCase()} path=${path}`
    if (only) console.warn(line)
    else console.info(line)
}

/** Why the API isn't there to send to, said as `cantReach` takes it. */
const NOT_RUNNING = 'isn\'t running (not started yet, stopped, or not set up)'

/** Sends the request to the API when it serves it (`DOMAINS`), and gives back its reply, or undefined to leave it to the
 * routes here: one the API doesn't serve, or one its line's check keeps here. With no API, one it serves fails. */
export async function routeToApi(event: H3Event, config: {apiUrl?: unknown, apiToken?: unknown}): Promise<unknown> {
    // Answered here unless the API answers it, which says so instead (`forwardToApi`).
    if (pathOf(event).startsWith('/api/')) setResponseHeader(event, SERVED_BY, 'nuxt')
    if (pathOf(event) === MCP) {
        if (!apiTarget(config)) await apiListening()
        const api = apiTarget(config)
        return api ? forwardMcp(event, api) : cantReach(event, NOT_RUNNING, 'not-running')
    }
    const found = lineOf(event.method, pathOf(event))
    if (!found) return undefined
    // A request that comes while the API is starting waits a few seconds for it, rather than failing.
    if (!apiTarget(config)) await apiListening()
    const api = apiTarget(config)
    if (!api) return cantReach(event, NOT_RUNNING, 'not-running')
    return forwardToApi(event, api)
}

/** What every request sent on to the API carries: the router's token, the database, who's asking and how it came. */
function headersFor(event: H3Event, api: {url: string, token: string}, actor: Actor): Record<string, string> {
    return {
        'Content-Type': getRequestHeader(event, 'content-type') ?? 'application/json',
        'Orrery-Api-Token': api.token,
        'Orrery-Database': databaseMark(databaseSetting()),
        ...actorHeaders(actor),
        ...askerHeaders(event, actor),
        ...whoHeaders(event.context.who as Who | undefined, getCookie(event, loginCookie(event)), bearer(event), {origin: getHeader(event, 'origin'), session: getHeader(event, 'orrery-session')}),
        ...loginHeaders({provider: oidcOn(), off: toldOff(), on: toldOn()}, getRequestURL(event, {xForwardedHost: true, xForwardedProto: true}).origin),
        ...cameHeaders({loopback: onLoopback(event), proxied: proxied(event), phone: viaPhone(event), https: getRequestURL(event, {xForwardedProto: true}).protocol === 'https:'}, getRequestHost(event)),
    }
}

/** `/mcp`, orrery's MCP tools over streamable HTTP, which only the Rust API serves (ORR-1098, ORR-1102). */
export const MCP = '/mcp'

/** The MCP headers a client and the server pass each other, which the API needs and the client needs back. */
const MCP_ASKED = ['accept', 'mcp-session-id', 'mcp-protocol-version'] as const
const MCP_ANSWERED = ['content-type', 'mcp-session-id', 'allow'] as const

/** Sends an `/mcp` request to the API as it came, JSON-RPC errors and all, with who's asking as for any route, and
 * passes on what its tools' routes set off (`orrery-*`, gathered by the API's mcp/relay.rs) as `relayed` does for a
 * route's reply: a comment carried to its session and the bell, an urgent push, the event log's lines. */
export async function forwardMcp(event: H3Event, api: {url: string, token: string}): Promise<unknown> {
    const actor = await actorOf(event)
    const body = event.method === 'POST' ? await readRawBody(event, false) : undefined
    const headers: Record<string, string> = headersFor(event, api, actor)
    for (const name of MCP_ASKED) {
        const value = getRequestHeader(event, name)
        if (value) headers[name] = value
    }
    let response: Response
    try {
        response = await fetch(`${api.url.replace(/\/+$/, '')}${MCP}`, {method: event.method, headers, body: body ? new Uint8Array(body) : undefined, redirect: 'manual'})
    } catch (error) {
        return cantReach(event, `at ${api.url} can't be reached (${(error as Error).message})`)
    }
    if (response.status === 421) return cantReach(event, `at ${api.url} is on another database than this server`, 'other-database')
    unreachable = ''
    setResponseHeader(event, SERVED_BY, 'rust')
    const text = await response.text()
    if (response.ok) await relayed(response, actor, event.method)
    setResponseStatus(event, response.status)
    for (const name of MCP_ANSWERED) {
        const value = response.headers.get(name)
        if (value) setResponseHeader(event, name, value)
    }
    // A notification's 202 has no body: an empty one, so the status stands.
    return text
}

/** Sends the request to the API and gives back its reply, or undefined for a request its line's check keeps for the
 * routes here. An API that can't be reached or is on another database fails the request (`cantReach`). */
export async function forwardToApi(event: H3Event, api: {url: string, token: string}): Promise<unknown> {
    const found = lineOf(event.method, pathOf(event))
    // The checks here read ids out of the path, so they get it as it was asked: lowercased, an issue isn't found (ORR-1029).
    const asked = /^\/api\/(.*?)\/?$/.exec(pathOf(event, true))?.[1] ?? ''
    const first = found?.line.first?.[event.method.toUpperCase()]
    if (first && await first(event, asked) === 'here') {
        servedHere(event, 'kept-here', first.name)
        return undefined
    }
    const shaped = found?.line.reply?.[event.method.toUpperCase()]?.(event)
    const actor = await actorOf(event)
    const body = WRITES.has(event.method) ? await readRawBody(event, false) : undefined
    const headers = headersFor(event, api, actor)
    let response: Response
    try {
        response = await fetch(`${api.url.replace(/\/+$/, '')}${shaped?.path ?? event.path}`, {method: event.method, headers, body: body ? new Uint8Array(body) : undefined, redirect: 'manual'})
    } catch (error) {
        return cantReach(event, `at ${api.url} can't be reached (${(error as Error).message})`)
    }
    // On another database than this server's: the owner moved it, and the API hasn't been started again on the new one.
    if (response.status === 421) return cantReach(event, `at ${api.url} is on another database than this server`, 'other-database')
    unreachable = ''
    setResponseHeader(event, SERVED_BY, 'rust')
    const passed = await passedThrough(response)
    if (passed) {
        setResponseStatus(event, response.status)
        for (const [name, value] of Object.entries(passed.headers)) setResponseHeader(event, name, value)
        return passed.body
    }
    const text = await response.text()
    const json = text ? JSON.parse(text) as Record<string, unknown> : null
    if (response.status >= 400) throw refusal(response.status, json)
    await relayed(response, actor, event.method)
    const counted = countedOf(event.method, pathOf(event))
    if (counted) countOwnUse(event, counted)
    setResponseStatus(event, response.status)
    if (response.status === 204) return null
    setResponseHeader(event, 'Content-Type', 'application/json')
    // A file to save (a board's export) keeps the name it's saved as.
    const saved = response.headers.get('content-disposition')
    if (saved) setResponseHeader(event, 'Content-Disposition', saved)
    return shaped ? shaped.reply(json) : json
}

/** A reply of 400 or more, as the error the routes here would throw. */
function refusal(status: number, json: Record<string, unknown> | null) {
    return createError({statusCode: status, statusMessage: String(json?.statusMessage ?? ''), message: String(json?.message ?? ''), ...json?.data === undefined ? {} : {data: json.data}})
}

/** Tells what a reply from the API says it set off, as the store would have: open pages read the project again, and the
 * event log, schedules and sessions hear it. `noteKeys` off: the caller notes a change of the settings itself. */
async function relayed(response: Response, actor: Actor, method: string, {noteKeys = true} = {}) {
    const store = useStore()
    // The API put what it set off in the outbox already, so the store's hooks don't again (ORR-929). While this server
    // follows the outbox, they hear it from there instead of from these headers (ORR-983).
    const relayHeaders = !followingOutbox()
    await store.relaying(async () => {
        if (relayHeaders) for (const project of changedOf(response.headers.get('orrery-changed'))) store.changed(project)
        // The statuses are in the settings, which open pages get again (ORR-926).
        if (relayHeaders && response.headers.get('orrery-settings') === '1') await store.settingsChanged()
        // Open pages ask for the epics again (ORR-1004).
        if (relayHeaders && response.headers.get('orrery-epics') === '1') store.epicsChanged()
        // The scheduler reads the event listeners again, and open pages the schedules (ORR-950).
        if (relayHeaders) for (const project of changedOf(response.headers.get('orrery-schedules'))) useScheduler().changedElsewhere(project)
        const keys = changedOf(response.headers.get('orrery-settings-keys'))
        if (noteKeys && keys.length) useEventLog().note({level: 'info', kind: 'settings.changed', message: `${actor.name} changed the settings: ${keys.join(', ')}`, details: {by: actor.name, keys}})
        // A session's ask for a schedule (ORR-1100), noted as the route here noted it.
        const asked = askedOf(response.headers.get('orrery-asked'))
        if (asked) useEventLog().note({level: 'info', kind: 'schedule.asked', project: asked.project, message: `${actor.session ?? actor.name} asked on ${asked.issue} to ${asked.line}`,
            details: {issue: asked.issue, schedule: asked.schedule, fields: asked.fields}})
        const answered = answeredOf(response.headers.get('orrery-answered'))
        if (answered) useEventLog().note({level: 'info', kind: 'schedule.answered', project: answered.project, message: `${actor.name} ${answered.how} the request on ${answered.issue} to ${answered.line}`,
            details: {issue: answered.issue, schedule: answered.schedule, fields: answered.fields, allowed: answered.how === 'allowed'}})
        if (relayHeaders) for (const {type, project, subject, from, to} of toldOf(response.headers.get('orrery-told'))) store.told(type, project, subject, actor, {from, to})
    })
    // Outside `relaying`: the signal and the bell's notice are this server's own, with their own rows in the outbox.
    for (const handoff of handoffsOf(response.headers)) await handOn(store, handoff, actor)
    for (const urgent of urgentOf(response.headers.get('orrery-urgent'))) await store.sayUrgent(urgent.project, urgent.issue, actor)
    // What it set off is told before the reply, as the page that asked reads the board next (ORR-1029).
    if (!relayHeaders && WRITES.has(method)) await caughtUp()
}

/** The runtime config, or none where there's no Nitro (unit tests that don't stub it). */
function configHere(): {apiUrl?: unknown, apiToken?: unknown} {
    try {
        return useRuntimeConfig()
    } catch {
        return {}
    }
}

/** A write this server makes itself rather than for a request, such as the chat's Allow (ORR-1044): with the API there
 * and serving `method` on `path` (`DOMAINS`, or `always` for a route only this server calls, like the chat's row), it's
 * sent there as the page's request would be, as `actor`, so the API stays the one writer of its tables and its outbox
 * hears it. The reply comes back as `{reply}`; undefined leaves it to the store here: a write the API doesn't serve, or a
 * server with no API set up at all (unit tests, a `nuxt dev` without its build). Once one is set up, it's the only
 * writer: down or unreachable, the write fails (`cantReach`). `noteKeys` off: the caller notes a settings change in the
 * event log itself. */
export async function writeToApi(method: string, path: string, body: unknown, actor: Actor, {always = false, noteKeys = true, config = configHere()} = {}): Promise<{reply: unknown} | undefined> {
    if (!always && !servedByApi(method, path)) return undefined
    const asked = `${method} ${path}`
    if (!apiTarget(config)) await apiListening()
    const api = apiTarget(config)
    if (!api) return meant ? cantReach(asked, NOT_RUNNING, 'not-running') : undefined
    let response: Response
    try {
        response = await fetch(`${api.url.replace(/\/+$/, '')}${path}`, {
            method,
            headers: {'Content-Type': 'application/json', 'Orrery-Api-Token': api.token, 'Orrery-Database': databaseMark(databaseSetting()), ...OWN_WORK, ...actorHeaders(actor)},
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual',
        })
    } catch (error) {
        return cantReach(asked, `at ${api.url} can't be reached (${(error as Error).message})`)
    }
    if (response.status === 421) return cantReach(asked, `at ${api.url} is on another database than this server`, 'other-database')
    unreachable = ''
    const text = await response.text()
    const json = text ? JSON.parse(text) as Record<string, unknown> : null
    if (response.status >= 400) throw refusal(response.status, json)
    await relayed(response, actor, method, {noteKeys})
    return {reply: json}
}
