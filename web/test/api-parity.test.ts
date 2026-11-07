// The Rust API's docs (ORR-922, api/), statuses and milestone and release reads (ORR-926), and issue and comment reads (ORR-927) against the store's: the same steps, one project through each, on one database
// (SQLite, or Postgres with TEST_POSTGRES_URL), and the same replies, failures and changes told. The API is the binary
// `cargo build` makes (api/target/debug/orrery-api, or ORRERY_API_BIN); without one this is skipped, and CI's `api` job
// builds it first.
import type {ChildProcess} from 'node:child_process'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {existsSync, mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import type {OrreryEvent} from '#shared/happenings'
import {Store} from '../server/utils/store'
import type {Actor, IssueFilter} from '../server/store/schema'
import {SqliteDb} from '../server/utils/database'
import {Secrets} from '../server/utils/secrets'
import {Pulls, pullForSession} from '../server/utils/pulls'
import {known} from '../shared/known'
import {numberOf} from '../shared/roadmap'
import {withoutClosed, withoutNotes} from '../shared/patch'
import {exportBoard} from '../server/utils/board-export'
import {RoadmapError, checkRoadmap} from '../server/utils/roadmap'
import {badRequest} from '../server/utils/input'
import {Schedules} from '../server/utils/schedules'
import {PullPoll} from '../server/utils/pull-poll'
import type {PolledRow} from '../server/utils/pull-poll'
import {openDb} from '../server/utils/db'
import {PostgresDb} from '../server/utils/postgres'
import {PHONE_LOGIN} from '#shared/phone'
import {actorHeaders, cameHeaders, changedOf, countedOf, databaseMark, domainOf, DOMAINS, handedOn, handoffsOf, handOn, loginHeaders, movesStatus, onlyWords, passedThrough, servedByApi, toldOf, urgentOf, whoHeaders} from '../server/utils/api-router'
import {permission, refused} from '../server/utils/permission'
import {followOutbox, readPage} from '../server/utils/outbox-follower'
import {contract, methodOf, nuxtRoutes, pathOf} from './routes'

const BIN = process.env.ORRERY_API_BIN || fileURLToPath(new URL('../../api/target/debug/orrery-api', import.meta.url))
const TOKEN = 'parity-token-0123456789'
const POSTGRES = process.env.TEST_POSTGRES_URL

/** What a step gave back, either side: its status and body, or its failure, what it said changed, and whether the
 * settings did (the statuses are in them, ORR-926). */
interface Outcome {status: number, body: unknown, changed: string[], told: string[], settings: boolean}

const AGENT: Actor = {name: 'agent', owner: false}
const SESSION: Actor = {name: 'agent', owner: false, session: 'orrery · Njord'}
const OWNER: Actor = {name: 'steffen', owner: true}

let store: Store
let api: ChildProcess
let url = ''
let setting = ''
let schema = ''
const changes: string[] = []
const events: OrreryEvent[] = []
let settingsTold = 0
const inFlight = new Set<Promise<unknown>>()

/** Every request this file sends the API, as `METHOD /api/path`, for the check that each route it serves is driven here
 * at least once (ORR-1010). */
const reached = new Set<string>()
const realFetch = globalThis.fetch
globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url && target.startsWith(url)) reached.add(`${(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()} ${new URL(target).pathname}`)
    return realFetch(input, init)
}

/** The routes of the contract, those written ahead of the router too, that no request here reached. */
function unreached(): string[] {
    const asked = [...reached]
    return [...contract(), ...contract(true)].filter(route => {
        const [method, path] = [methodOf(route), route.slice(route.indexOf(' ') + 1)]
        const pattern = new RegExp(`^${method} ${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '[^/]+')}/?$`)
        return !asked.some(request => pattern.test(request))
    })
}

describe.skipIf(!existsSync(BIN))('the Rust API serves docs and the statuses, and reads issues and comments, as the store does', () => {
    beforeAll(async () => {
        schema = `test_api_${Date.now().toString(36)}`
        if (POSTGRES) {
            setting = POSTGRES
            store = new Store(new PostgresDb(POSTGRES, schema), project => changes.push(project), undefined, undefined, () => settingsTold++)
        } else {
            setting = resolve(join(mkdtempSync(join(tmpdir(), 'orrery-api-')), 'orrery.db'))
            store = new Store(new SqliteDb(openDb(setting)), project => changes.push(project), undefined, undefined, () => settingsTold++)
        }
        store.happened = event => events.push(event)
        // `changed()` looks up the projects sharing a release after it returns, and tells them when that answers. On
        // Postgres's pool that can land in a later step: `settle()` waits for the store's queries in flight first.
        const all = (store as unknown as {all: (...args: unknown[]) => Promise<unknown>}).all.bind(store)
        ;(store as unknown as {all: (...args: unknown[]) => Promise<unknown>}).all = (...args) => {
            const query = all(...args)
            inFlight.add(query)
            void query.finally(() => inFlight.delete(query)).catch(() => {})
            return query
        }
        // Both projects first, which on Postgres also lays the schema down before the API looks at it.
        for (const name of ['through-store', 'through-api']) await store.createProject({name, key: name === 'through-store' ? 'STO' : 'API'})
        api = spawn(BIN, [], {env: {...process.env, NUXT_API_TOKEN: TOKEN, NUXT_DATABASE: setting, ORRERY_API_LISTEN: '127.0.0.1:0', ...POSTGRES ? {ORRERY_API_SCHEMA: schema} : {}}})
        url = await new Promise<string>((done, fail) => {
            let said = ''
            api.stderr!.on('data', (chunk: Buffer) => {
                said += chunk
                const at = /serving docs on (http:\/\/\S+),/.exec(said)
                if (at) done(at[1]!)
            })
            api.on('exit', code => fail(new Error(`the API stopped (${code}): ${said}`)))
        })
    }, 30_000)

    afterAll(async () => {
        api?.kill()
        if (store?.db instanceof PostgresDb) await store.db.close()
    })

    /** The outbox's newest id, a page at a time: a read with no cursor gives only the oldest page (500 rows). */
    async function newestChange(): Promise<number> {
        let last = 0
        for (let page; (page = (await viaApi('GET', `/api/changes?after=${last}`)).body as {changes: unknown[], last: number}).changes.length;) last = page.last
        return last
    }

    /** Waits for the store's queries in flight, and what they tell once they answer. */
    async function settle() {
        while (inFlight.size) await Promise.allSettled([...inFlight])
        await new Promise(done => setImmediate(done))
    }

    /** The projects told of a change to `projects`: each, and those sharing its releases, as `store.changed` tells them.
     * The router hands it each project the API names; the store finds the sharing ones after the commit, too late for
     * a step to see every time, so both sides are counted this way (ORR-974). */
    async function sharing(projects: string[]): Promise<string[]> {
        const each = await Promise.all(projects.map(async p => [p, ...(await store.db.all<{id: string}>(
            'SELECT id FROM projects WHERE releases_from = ? OR id = (SELECT releases_from FROM projects WHERE id = ?)', p, p)).map(r => r.id)]))
        return [...new Set(each.flat())].sort()
    }

    /** Until the changes a write set off have all been heard. Each project a write changes also changes the projects
     * sharing its releases, found by a query nobody waits for, so on Postgres those can land in the next step's. */
    async function quiet() {
        let heard: number
        do {
            heard = changes.length
            await new Promise(resolve => setTimeout(resolve, 50))
        } while (changes.length !== heard)
    }

    /** A step through the store, as its route would answer it. */
    async function viaStore(step: () => Promise<unknown>, status = 200): Promise<Outcome> {
        await settle()
        const [before, told, settings] = [changes.length, events.length, settingsTold]
        try {
            const value = await step()
            const made = value && typeof value === 'object' && 'created' in value && 'doc' in value
            const body = made ? (value as {doc: unknown}).doc : value === undefined ? null : value
            return {
                status: made && (value as {created: boolean}).created ? 201 : body === null ? 204 : status, body, changed: await sharing(changes.slice(before)),
                told: events.slice(told).map(e => `${e.type} ${e.subject}`), settings: settingsTold > settings,
            }
        } catch (error) {
            const {statusCode, message, data} = error as {statusCode: number, message: string, data?: unknown}
            return {status: statusCode, body: {message, ...data === undefined ? {} : {data}}, changed: [], told: [], settings: false}
        }
    }

    /** The same step through the API, with what the router does after it: a new comment passed on to the sessions and the
     * owner's bell (`handedOn`, ORR-927). */
    async function viaApi(method: string, path: string, body?: unknown, actor: Actor = AGENT, project = 'through-api', extra: Record<string, string> = {}): Promise<Outcome> {
        // A path of the orrery's own (`/api/statuses`) as it is; else one of the project's.
        const response = await fetch(path.startsWith('/api/') ? `${url}${path}` : `${url}/api/projects/${project}${path}`, {
            method,
            headers: {'Content-Type': 'application/json', 'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...actorHeaders(actor), ...extra},
            ...body === undefined ? {} : {body: JSON.stringify(body)},
        })
        const text = await response.text()
        const json = text ? JSON.parse(text) as Record<string, unknown> : null
        const changed = response.headers.get('orrery-changed')
        const told = toldOf(response.headers.get('orrery-told')).map(t => `${t.type} ${t.subject}`)
        if (response.status >= 400) return {status: response.status, body: {message: json!.message, ...json!.data === undefined ? {} : {data: json!.data}}, changed: [], told: [], settings: false}
        for (const handoff of handoffsOf(response.headers)) await handOn(store, handoff, actor)
        for (const urgent of urgentOf(response.headers.get('orrery-urgent'))) await store.sayUrgent(urgent.project, urgent.issue, actor)
        return {status: response.status, body: json, changed: await sharing(changedOf(changed)), told, settings: response.headers.get('orrery-settings') === '1'}
    }

    /** Both sides' outcomes with what's bound to differ taken out: the project, its uid and key (in an issue's id too),
     * times, revision and comment ids (numbered across the orrery, so the two projects' interleave), and the order a set
     * came in. */
    function same(outcome: Outcome, project: string): unknown {
        const revisions = new Map<number, number>()
        return JSON.parse(JSON.stringify(outcome, (key, value: unknown) => {
            if (typeof value === 'string') {
                return value.replaceAll(project, '<project>').replace(/\b(STO|API)([DPSXTKI]?)-(\d+)/g, 'KEY$2-$3').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '<time>').replace(/-[a-z2-7]{8}$/, '-<uid>')
            }
            if (typeof value === 'number' && (key === 'id' || key === 'revision') && Number.isInteger(value)) {
                if (!revisions.has(value)) revisions.set(value, revisions.size + 1)
                return `rev ${revisions.get(value)}`
            }
            return value
        }))
    }

    /** The same read of the orrery's own rows (not a project's) through each side. */
    async function alike0(name: string, ts: () => Promise<Outcome>, rs: () => Promise<Outcome>) {
        const [a, b] = [await ts(), await rs()]
        expect(b, name).toEqual(a)
        return b
    }

    async function both(name: string, ts: (project: string) => Promise<Outcome>, rs: () => Promise<Outcome>) {
        const [a, b] = [await ts('through-store'), await rs()]
        expect(same(b, 'through-api'), name).toEqual(same(a, 'through-store'))
        return b
    }

    it('makes, lists, reads, syncs, changes and refuses docs alike', async () => {
        await both('a doc in a section', p => viaStore(() => store.createDoc(p, {title: 'How joints work', body: '# Joints\n\nA **hinge** turns.', section: ' How it works '}, SESSION), 201),
            () => viaApi('POST', '/docs', {title: 'How joints work', body: '# Joints\n\nA **hinge** turns.', section: ' How it works '}, SESSION))
        await both('the same title again gets a number', p => viaStore(() => store.createDoc(p, {title: 'How joints work'}), 201),
            () => viaApi('POST', '/docs', {title: 'How joints work'}))
        await both('an artifact with its own id, the owner\'s', p => viaStore(() => store.createDoc(p, {title: 'Ideas', id: 'ideas', kind: 'artifact', body: '<p>x</p>'}, OWNER), 201),
            () => viaApi('POST', '/docs', {title: 'Ideas', id: 'ideas', kind: 'artifact', body: '<p>x</p>'}, OWNER))
        await both('a taken id', p => viaStore(() => store.createDoc(p, {title: 'Again', id: 'ideas'})), () => viaApi('POST', '/docs', {title: 'Again', id: 'ideas'}))
        await both('an empty title', p => viaStore(() => store.createDoc(p, {title: '  '})), () => viaApi('POST', '/docs', {title: '  '}))
        await both('several problems', p => viaStore(() => store.createDoc(p, {bogus: 1, position: 'a', kind: 'pdf', id: 'Not An Id'})),
            () => viaApi('POST', '/docs', {bogus: 1, position: 'a', kind: 'pdf', id: 'Not An Id'}))
        await both('no body', p => viaStore(() => store.createDoc(p, undefined)), () => viaApi('POST', '/docs'))
        await both('the list', p => viaStore(() => store.listDocs(p)), () => viaApi('GET', '/docs'))
        await both('a search', p => viaStore(() => store.listDocs(p, {q: 'HINGE'})), () => viaApi('GET', '/docs?q=HINGE'))
        await both('a doc', p => viaStore(() => store.doc(p, 'how-joints-work')), () => viaApi('GET', '/docs/how-joints-work'))
        await both('a doc that isn\'t there', p => viaStore(() => store.doc(p, 'nope')), () => viaApi('GET', '/docs/nope'))
        await both('a project that isn\'t there', () => viaStore(() => store.listDocs('nowhere')), () => viaApi('GET', '/docs', undefined, AGENT, 'nowhere'))
        await both('synced from a repo: made', p => viaStore(() => store.putDoc(p, 'synced', {title: 'Synced', body: 'one'})), () => viaApi('PUT', '/docs/synced', {title: 'Synced', body: 'one'}))
        await both('synced from a repo: replaced', p => viaStore(() => store.putDoc(p, 'synced', {title: 'Synced', body: 'two'})), () => viaApi('PUT', '/docs/synced', {title: 'Synced', body: 'two'}))
        await both('synced with another id in the body', p => viaStore(() => store.putDoc(p, 'synced', {title: 'S', id: 'other'})), () => viaApi('PUT', '/docs/synced', {title: 'S', id: 'other'}))
        await both('synced to a full id from another board', p => viaStore(() => store.putDoc(p, 'doc-x-abcdefgh', {title: 'S'})), () => viaApi('PUT', '/docs/doc-x-abcdefgh', {title: 'S'}))
        await both('retitled and taken out of its section', p => viaStore(() => store.updateDoc(p, 'how-joints-work', {title: ' Joints ', section: null})),
            () => viaApi('PATCH', '/docs/how-joints-work', {title: ' Joints ', section: null}))
        await both('only moved, which is no revision', p => viaStore(() => store.updateDoc(p, 'how-joints-work', {position: 9, section: 'Elsewhere'})),
            () => viaApi('PATCH', '/docs/how-joints-work', {position: 9, section: 'Elsewhere'}))
        await both('another kind', p => viaStore(() => store.updateDoc(p, 'how-joints-work', {kind: 'artifact'})), () => viaApi('PATCH', '/docs/how-joints-work', {kind: 'artifact'}))
        await both('another id', p => viaStore(() => store.updateDoc(p, 'how-joints-work', {id: 'x'})), () => viaApi('PATCH', '/docs/how-joints-work', {id: 'x'}))
        await both('the owner\'s doc, deleted by an agent', p => viaStore(() => store.deleteDoc(p, 'ideas', AGENT)), () => viaApi('DELETE', '/docs/ideas', undefined, AGENT))
        await both('a doc deleted', p => viaStore(() => store.deleteDoc(p, 'how-joints-work-2')), () => viaApi('DELETE', '/docs/how-joints-work-2'))
        await both('the owner\'s doc, deleted by the owner', p => viaStore(() => store.deleteDoc(p, 'ideas', OWNER)), () => viaApi('DELETE', '/docs/ideas', undefined, OWNER))
        await both('what\'s deleted', p => viaStore(() => store.deletedDocs(p)), () => viaApi('GET', '/deleted-docs'))
        await both('a doc\'s history', p => viaStore(() => store.docRevisions(p, 'how-joints-work')), () => viaApi('GET', '/docs/how-joints-work/revisions'))
        await both('a deleted doc\'s history', p => viaStore(() => store.docRevisions(p, 'ideas')), () => viaApi('GET', '/docs/ideas/revisions'))
        await both('no history', p => viaStore(() => store.docRevisions(p, 'never')), () => viaApi('GET', '/docs/never/revisions'))
    })

    it('reads and restores revisions alike', async () => {
        const first = async (project: string, doc: string) => (await store.docRevisions(project, doc)).at(-1)!.id
        for (const [doc, name] of [['how-joints-work', 'an old revision onto a live doc'], ['ideas', 'a deleted doc brought back'], ['synced', 'the text it has already']] as const) {
            if (doc === 'synced') {
                const latest = async (project: string) => (await store.docRevisions(project, doc))[0]!.id
                await both(name, async p => viaStore(async () => store.restoreDoc(p, doc, await latest(p))), async () => viaApi('POST', `/docs/${doc}/revisions/${await latest('through-api')}/restore`))
                continue
            }
            await both(`revision of ${doc}`, async p => viaStore(async () => store.docRevision(p, doc, await first(p, doc))), async () => viaApi('GET', `/docs/${doc}/revisions/${await first('through-api', doc)}`))
            await both(name, async p => viaStore(async () => store.restoreDoc(p, doc, await first(p, doc))), async () => viaApi('POST', `/docs/${doc}/revisions/${await first('through-api', doc)}/restore`))
        }
        await both('a revision that isn\'t there', p => viaStore(() => store.docRevision(p, 'ideas', 99_999_999)), () => viaApi('GET', '/docs/ideas/revisions/99999999'))
        await both('the list after', p => viaStore(() => store.listDocs(p)), () => viaApi('GET', '/docs'))
    })

    it('makes, renames, moves and deletes sections alike', async () => {
        const steps: [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>][] = [
            ['a section', p => viaStore(() => store.createDocSection(p, {name: 'Zebra'}).then(name => ({name})), 201), () => viaApi('POST', '/doc-sections', {name: 'Zebra'})],
            ['another', p => viaStore(() => store.createDocSection(p, {name: 'Decisions'}).then(name => ({name})), 201), () => viaApi('POST', '/doc-sections', {name: 'Decisions'})],
            ['one there already', p => viaStore(() => store.createDocSection(p, {name: 'Decisions'})), () => viaApi('POST', '/doc-sections', {name: 'Decisions'})],
            ['no name', p => viaStore(() => store.createDocSection(p, {name: '   '})), () => viaApi('POST', '/doc-sections', {name: '   '})],
            ['the sections', p => viaStore(() => store.docSections(p)), () => viaApi('GET', '/doc-sections')],
            ['renamed', p => viaStore(() => store.updateDocSection(p, 'Zebra', {name: 'Alpha'}).then(name => ({name}))), () => viaApi('PATCH', '/doc-sections/Zebra', {name: 'Alpha'})],
            ['renamed onto another', p => viaStore(() => store.updateDocSection(p, 'Alpha', {name: 'Decisions'})), () => viaApi('PATCH', '/doc-sections/Alpha', {name: 'Decisions'})],
            ['moved to the top', p => viaStore(() => store.updateDocSection(p, 'Decisions', {position: 0}).then(name => ({name}))), () => viaApi('PATCH', '/doc-sections/Decisions', {position: 0})],
            ['moved past the end', p => viaStore(() => store.updateDocSection(p, 'Decisions', {position: 40}).then(name => ({name}))), () => viaApi('PATCH', '/doc-sections/Decisions', {position: 40})],
            ['a bad position', p => viaStore(() => store.updateDocSection(p, 'Decisions', {position: -1})), () => viaApi('PATCH', '/doc-sections/Decisions', {position: -1})],
            ['the sections after', p => viaStore(() => store.docSections(p)), () => viaApi('GET', '/doc-sections')],
            ['one with a doc in it, deleted', p => viaStore(() => store.deleteDocSection(p, 'Elsewhere')), () => viaApi('DELETE', '/doc-sections/Elsewhere')],
            ['one that isn\'t there', p => viaStore(() => store.deleteDocSection(p, 'Elsewhere')), () => viaApi('DELETE', '/doc-sections/Elsewhere')],
            ['the sections at the end', p => viaStore(() => store.docSections(p)), () => viaApi('GET', '/doc-sections')],
            ['the docs at the end', p => viaStore(() => store.listDocs(p)), () => viaApi('GET', '/docs')],
        ]
        for (const [name, ts, rs] of steps) await both(name, ts, rs)
    })

    it('lists, adds, changes, refuses and removes statuses alike (ORR-926)', async () => {
        // The statuses are the orrery's, not a project's, so each side runs every step in turn on the same table, put
        // back as it was between them; a status with an issue in it has one on each side's own project.
        type Step = [string, (project: string) => Promise<Outcome>, () => Promise<Outcome>]
        const issueIn = async (project: string): Promise<Outcome> => {
            await store.createIssue(project, {title: 'Check the hinges', status: 'review'})
            return {status: 201, body: null, changed: [], told: [], settings: false}
        }
        const steps: Step[] = [
            ['the statuses', () => viaStore(() => store.statuses()), () => viaApi('GET', '/api/statuses')],
            ['added by a session', () => viaStore(() => store.createStatus({name: 'Review', kind: 'started'}, SESSION)), () => viaApi('POST', '/api/statuses', {name: 'Review', kind: 'started'}, SESSION)],
            ['added', () => viaStore(() => store.createStatus({name: ' Review ', kind: 'started', color: 'violet'}, OWNER), 201), () => viaApi('POST', '/api/statuses', {name: ' Review ', kind: 'started', color: 'violet'}, OWNER)],
            ['added again', () => viaStore(() => store.createStatus({name: 'Review', kind: 'started'}, OWNER)), () => viaApi('POST', '/api/statuses', {name: 'Review', kind: 'started'}, OWNER)],
            ['with its own id and place', () => viaStore(() => store.createStatus({name: 'QA', id: 'qa', kind: 'started', position: 2.5, color: '#AABBCC'}, OWNER), 201),
                () => viaApi('POST', '/api/statuses', {name: 'QA', id: 'qa', kind: 'started', position: 2.5, color: '#AABBCC'}, OWNER)],
            ['several problems', () => viaStore(() => store.createStatus({bogus: 1, id: 'Bad Id', kind: 'later', color: 'pink', position: 'x'}, OWNER)),
                () => viaApi('POST', '/api/statuses', {bogus: 1, id: 'Bad Id', kind: 'later', color: 'pink', position: 'x'}, OWNER)],
            ['an empty name and a null colour', () => viaStore(() => store.createStatus({name: ' ', kind: 'todo', color: null}, OWNER)), () => viaApi('POST', '/api/statuses', {name: ' ', kind: 'todo', color: null}, OWNER)],
            ['no body', () => viaStore(() => store.createStatus(undefined, OWNER)), () => viaApi('POST', '/api/statuses', undefined, OWNER)],
            ['a name that makes no id', () => viaStore(() => store.createStatus({name: '!!!', kind: 'todo'}, OWNER)), () => viaApi('POST', '/api/statuses', {name: '!!!', kind: 'todo'}, OWNER)],
            ['proposed', () => viaStore(() => store.createStatus({name: 'Proposed', kind: 'todo'}, OWNER)), () => viaApi('POST', '/api/statuses', {name: 'Proposed', kind: 'todo'}, OWNER)],
            ['the statuses after', () => viaStore(() => store.statuses()), () => viaApi('GET', '/api/statuses')],
            ['renamed and recoloured', () => viaStore(() => store.updateStatus('review', {name: ' In QA ', color: 'teal'}, OWNER)), () => viaApi('PATCH', '/api/statuses/review', {name: ' In QA ', color: 'teal'}, OWNER)],
            ['moved to another kind', () => viaStore(() => store.updateStatus('qa', {kind: 'todo', position: 0.5}, OWNER)), () => viaApi('PATCH', '/api/statuses/qa', {kind: 'todo', position: 0.5}, OWNER)],
            ['the same id sent', () => viaStore(() => store.updateStatus('qa', {id: 'qa'}, OWNER)), () => viaApi('PATCH', '/api/statuses/qa', {id: 'qa'}, OWNER)],
            ['another id', () => viaStore(() => store.updateStatus('qa', {id: 'other'}, OWNER)), () => viaApi('PATCH', '/api/statuses/qa', {id: 'other'}, OWNER)],
            ['the last of its kind, given another', () => viaStore(() => store.updateStatus('backlog', {kind: 'todo'}, OWNER)), () => viaApi('PATCH', '/api/statuses/backlog', {kind: 'todo'}, OWNER)],
            ['a null name', () => viaStore(() => store.updateStatus('qa', {name: null}, OWNER)), () => viaApi('PATCH', '/api/statuses/qa', {name: null}, OWNER)],
            ['one that isn\'t there', () => viaStore(() => store.updateStatus('nope', {name: 'X'}, OWNER)), () => viaApi('PATCH', '/api/statuses/nope', {name: 'X'}, OWNER)],
            ['changed by a session', () => viaStore(() => store.updateStatus('qa', {name: 'X'}, SESSION)), () => viaApi('PATCH', '/api/statuses/qa', {name: 'X'}, SESSION)],
            ['the last of its kind, removed', () => viaStore(() => store.deleteStatus('backlog', undefined, OWNER)), () => viaApi('DELETE', '/api/statuses/backlog', undefined, OWNER)],
            ['removed by a session', () => viaStore(() => store.deleteStatus('qa', undefined, SESSION)), () => viaApi('DELETE', '/api/statuses/qa', undefined, SESSION)],
            // Made through the store on both sides, not compared: only the issue it leaves in the status counts.
            ['an issue in one', p => issueIn(p), () => issueIn('through-api')],
            ['removed with an issue in it', () => viaStore(() => store.deleteStatus('review', undefined, OWNER)), () => viaApi('DELETE', '/api/statuses/review', undefined, OWNER)],
            ['moved into itself', () => viaStore(() => store.deleteStatus('review', 'review', OWNER)), () => viaApi('DELETE', '/api/statuses/review?into=review', undefined, OWNER)],
            ['moved into one that isn\'t there', () => viaStore(() => store.deleteStatus('review', 'nope', OWNER)), () => viaApi('DELETE', '/api/statuses/review?into=nope', undefined, OWNER)],
            ['removed, its issue moved', () => viaStore(() => store.deleteStatus('review', 'todo', OWNER)), () => viaApi('DELETE', '/api/statuses/review?into=todo', undefined, OWNER)],
            ['the issue where it went', p => viaStore(async () => (await store.listIssues(p)).map(i => ({title: i.title, status: i.status}))),
                () => viaStore(async () => (await store.listIssues('through-api')).map(i => ({title: i.title, status: i.status})))],
            ['an empty one removed', () => viaStore(() => store.deleteStatus('qa', undefined, OWNER)), () => viaApi('DELETE', '/api/statuses/qa', undefined, OWNER)],
            ['the statuses at the end', () => viaStore(() => store.statuses()), () => viaApi('GET', '/api/statuses')],
        ]
        const before = await store.statuses()
        const putBack = async () => {
            const ids = before.map(s => s.id)
            for (const s of before) await store.db.run('UPDATE statuses SET name = ?, kind = ?, color = ?, position = ? WHERE id = ?', s.name, s.kind, s.color, s.position, s.id)
            for (const s of await store.statuses()) if (!ids.includes(s.id)) await store.db.run('DELETE FROM statuses WHERE id = ?', s.id)
        }
        const run = async (side: (step: Step) => Promise<Outcome>) => {
            const outcomes: Outcome[] = []
            for (const step of steps) outcomes.push(await side(step))
            await putBack()
            return outcomes
        }
        const viaTs = await run(([, ts]) => ts('through-store'))
        const viaRs = await run(([, , rs]) => rs())
        // Every project changed both ways: the two names are the same here.
        const projects = (outcome: Outcome) => ({...outcome, changed: outcome.changed.map(() => '<a project>')})
        steps.forEach(([name], i) => expect(same(projects(viaRs[i]!), 'through-api'), name).toEqual(same(projects(viaTs[i]!), 'through-store')))
        expect(viaRs[2]).toMatchObject({status: 201, settings: true, changed: ['through-api', 'through-store']})
    })

    it('lists and reads issues alike, with every filter (ORR-927)', async () => {
        const ids: Record<string, Record<string, string>> = {}
        const uid = async (p: string) => (await store.issue(p, ids[p]!.lid!)).full_id.split('-').at(-1)!
        const release = async (p: string) => viaStore(() => store.listIssues(p, {release: '1.0.0'}))
        // Before the projects have releases: the filter is refused.
        await both('a release on a project with none', release, () => viaApi('GET', '/issues?release=1.0.0'))
        for (const p of ['through-store', 'through-api']) {
            await store.updateProject(p, {release_mode: 'own', repo: 'https://github.com/ada/box'}, OWNER)
            await store.createRelease(p, {version: '1.0.0'}, OWNER)
            const {id: milestone} = await store.createMilestone(p, {title: 'The lid'}, OWNER)
            const {id: lid} = await store.createIssue(p, {title: 'Hinge the lid', milestone, priority: 'P1', labels: ['ui'], assignee: 'owner', release: '1.0.0',
                github_issues: ['523'], notes: 'The lid needs a hinge that turns smoothly.'}, OWNER)
            const {id: oil} = await store.createIssue(p, {title: 'Oil the hinge', parent: lid, status: 'done'}, OWNER)
            const {id: paint} = await store.createIssue(p, {title: 'Paint it', parent: lid, status: 'started', external: ['task-9']}, OWNER)
            const {id: ship} = await store.createIssue(p, {title: 'Ship the box', depends_on: [lid]}, OWNER)
            const {id: brass} = await store.createIssue(p, {title: 'Try a brass one', proposal: 'pending', labels: ['external']})
            const {id: sand} = await store.createIssue(p, {title: 'Sand the edges', status: 'canceled'}, OWNER)
            await store.createComment(p, ship, {body: 'Which courier?', asks: 'decision'}, SESSION)
            await store.createComment(p, sand, {body: 'The sandpaper was too coarse for the oak.'})
            await store.createComment(p, brass, {body: 'Brass would tarnish near the coarse salt air.'})
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${p === 'through-store' ? 'STO' : 'API'}-77`, lid)
            await store.db.run('UPDATE issues SET claimed_by = ?, claimed_at = ? WHERE project = ? AND id = ?', 'steffen', new Date().toISOString(), p, paint)
            for (const [number, risk, by] of [[1, 'low', 'session'], [2, 'high', 'owner'], [3, 'high', 'session']] as const) {
                await store.db.run(`INSERT INTO issue_pulls (project, issue, repo, number, title, url, branch, base, author, state, created_at, updated_at, risk, risk_why, risk_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p, lid, `ada/${p}`, number, 'Hinges', 'https://github.com/ada/box/pull/1', 'feat/hinge', 'main', 'ada', 'open',
                new Date().toISOString(), new Date().toISOString(), risk, `Because ${number}`, by)
            }
            ids[p] = {milestone, lid, oil, paint, ship, brass, sand}
        }
        const list = (filter: Record<string, string>) => [
            (p: string) => viaStore(() => store.listIssues(p, filter as IssueFilter)),
            () => viaApi('GET', `/issues${Object.keys(filter).length ? `?${new URLSearchParams(filter)}` : ''}`),
        ] as const
        const filters: [string, Record<string, string>][] = [
            ['all of them', {}],
            ['by status', {status: 'todo'}], ['by kinds and an old word', {status: 'started, done,doing'}], ['by a status there isn\'t', {status: 'nope'}],
            ['proposed', {column: 'proposed'}], ['by column', {column: 'canceled'}],
            ['by priority', {priority: 'P1'}], ['with none', {priority: 'none'}],
            ['the owner\'s', {assignee: 'OWNER'}], ['nobody\'s', {assignee: 'none'}], ['someone else\'s', {assignee: 'ada'}],
            ['by label', {label: 'ui'}], ['by task', {external: 'task-9'}],
            ['by a GitHub number', {github_issue: '#523'}], ['by a GitHub link', {github_issue: 'https://github.com/ADA/box/issues/523'}],
            ['not a GitHub issue', {github_issue: 'nope'}],
            ['by release', {release: '1.0.0'}], ['in none', {release: 'none'}], ['a release there isn\'t', {release: '9.9'}],
            ['no milestone', {milestone: 'none'}], ['a milestone there isn\'t', {milestone: '99'}],
            ['top-level', {parent: 'none'}],
            ['pending', {proposal: 'pending'}], ['committed', {proposal: 'none'}],
            ['blocked', {blocked: 'true'}], ['not blocked', {blocked: 'false'}],
            ['by id or title', {q: 'HINGE'}], ['by an id', {q: 'key'}],
            ['in their text', {q: 'coarse', in: 'all'}], ['in a description and a title', {q: 'hinge', in: 'all'}], ['words in no one place', {q: 'oak smoothly', in: 'all'}],
            ['several at once', {status: 'todo,started', label: 'ui', parent: 'none'}],
            ['an unknown filter', {bogus: '1'}],
        ]
        for (const [name, filter] of filters) await both(name, ...list(filter))
        // Filters naming an id, each side its own.
        await both('by milestone', p => viaStore(() => store.listIssues(p, {milestone: ids[p]!.milestone!})), () => viaApi('GET', `/issues?milestone=${ids['through-api']!.milestone}`))
        await both('by a milestone\'s full id', async p => viaStore(async () => store.listIssues(p, {milestone: `mls-${ids[p]!.milestone}-${await uid(p)}`})),
            async () => viaApi('GET', `/issues?milestone=mls-${ids['through-api']!.milestone}-${await uid('through-api')}`))
        await both('by parent', p => viaStore(() => store.listIssues(p, {parent: ids[p]!.lid!})), () => viaApi('GET', `/issues?parent=${ids['through-api']!.lid}`))
        await both('by a parent\'s old id', p => viaStore(() => store.listIssues(p, {parent: `${p === 'through-store' ? 'STO' : 'API'}-77`})), () => viaApi('GET', '/issues?parent=API-77'))
        await both('in a project that isn\'t there', () => viaStore(() => store.listIssues('nowhere')), () => viaApi('GET', '/issues', undefined, AGENT, 'nowhere'))
        // One issue.
        const one = (name: string, id: (p: string) => Promise<string> | string) => both(name, async p => viaStore(async () => store.issue(p, await id(p))), async () => viaApi('GET', `/issues/${await id('through-api')}`))
        await one('with sub-issues, links, risk and a claimed one', p => ids[p]!.lid!)
        await one('a sub-issue', p => ids[p]!.oil!)
        await one('blocked and waiting', p => ids[p]!.ship!)
        await one('a proposal', p => ids[p]!.brass!)
        await one('by an old id', p => `${p === 'through-store' ? 'STO' : 'API'}-77`)
        await one('by its full id', async p => `${ids[p]!.lid}-${await uid(p)}`)
        await one('one that isn\'t there', () => 'X-404')
        await both('in a project that isn\'t there', () => viaStore(() => store.issue('nowhere', 'X-1')), () => viaApi('GET', '/issues/X-1', undefined, AGENT, 'nowhere'))
        // The steps compared something: the board has what was made.
        const lid = await viaApi('GET', `/issues/${ids['through-api']!.lid}`)
        expect(lid.body).toMatchObject({column: 'in-progress', counts: {'done': 1, 'in-progress': 1}, risk: {level: 'high', by: 'owner'}, aliases: ['API-77']})
    })

    it('reads an issue\'s comments alike (ORR-927)', async () => {
        const request = {title: 'Nightly', changes: [{field: 'cron' as const, to: '0 3 * * *'}], body: {cron: '0 3 * * *'}, state: 'asked' as const}
        const ids: Record<string, string> = {}
        for (const p of ['through-store', 'through-api']) {
            const {id} = await store.createIssue(p, {title: 'Talk it over'}, OWNER)
            const {id: quiet} = await store.createIssue(p, {title: 'Nobody spoke'})
            ids[p] = id
            ids[`${p} quiet`] = quiet
            await store.createComment(p, id, {body: 'Which way?', asks: 'decision'}, SESSION)
            await store.createComment(p, id, {body: 'Is this fine?', asks: 'feedback'})
            await store.createComment(p, id, {body: 'The left one.'}, OWNER)
            await store.askForSchedule(p, id, 'Make the nightly run?', request, SESSION)
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${p === 'through-store' ? 'STO' : 'API'}-90`, id)
        }
        const full = async (p: string) => (await store.issue(p, ids[p]!)).full_id
        const first = async (p: string) => (await store.listComments(p, ids[p]!))[0]!.id
        const last = async (p: string) => (await store.listComments(p, ids[p]!)).at(-1)!.id
        const steps: [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>][] = [
            ['the comments, answered and not, with a schedule request', p => viaStore(() => store.listComments(p, ids[p]!)), () => viaApi('GET', `/issues/${ids['through-api']}/comments`)],
            ['none yet', p => viaStore(() => store.listComments(p, ids[`${p} quiet`]!)), () => viaApi('GET', `/issues/${ids['through-api quiet']}/comments`)],
            ['by an id it had before', p => viaStore(() => store.listComments(p, 'X-90'.replace('X', p === 'through-store' ? 'STO' : 'API'))), () => viaApi('GET', '/issues/API-90/comments')],
            ['by its full id', async p => viaStore(async () => store.listComments(p, await full(p))), async () => viaApi('GET', `/issues/${await full('through-api')}/comments`)],
            ['an issue that isn\'t there', p => viaStore(() => store.listComments(p, 'X-404')), () => viaApi('GET', '/issues/X-404/comments')],
            ['a project that isn\'t there', () => viaStore(() => store.listComments('nowhere', 'X-1')), () => viaApi('GET', '/issues/X-1/comments', undefined, AGENT, 'nowhere')],
            ['one that asks, answered', async p => viaStore(async () => store.comment(p, ids[p]!, await first(p))), async () => viaApi('GET', `/issues/${ids['through-api']}/comments/${await first('through-api')}`)],
            ['one with a schedule request', async p => viaStore(async () => store.comment(p, ids[p]!, await last(p))), async () => viaApi('GET', `/issues/${ids['through-api']}/comments/${await last('through-api')}`)],
            ['one by its issue\'s full id', async p => viaStore(async () => store.comment(p, await full(p), await first(p))), async () => viaApi('GET', `/issues/${await full('through-api')}/comments/${await first('through-api')}`)],
            ['one that isn\'t there', p => viaStore(() => store.comment(p, ids[p]!, 99_999_999)), () => viaApi('GET', `/issues/${ids['through-api']}/comments/99999999`)],
        ]
        for (const [name, ts, rs] of steps) await both(name, ts, rs)
        // On another issue: the message names the comment's id, which differs between the two projects.
        const elsewhere = await viaApi('GET', `/issues/${ids['through-api quiet']}/comments/${await first('through-api')}`)
        expect(elsewhere).toMatchObject({status: 404, body: {message: `No comment ${await first('through-api')} on ${ids['through-api quiet']}`}})
        // Not a whole number: the route's `commentId` refuses it before the store is asked.
        expect((await viaApi('GET', `/issues/${ids['through-api']}/comments/abc`)).body).toEqual({message: 'No comment abc'})
        expect((await viaApi('GET', `/issues/${ids['through-api']}/comments/1.5`)).status).toBe(404)
    })

    it('reads an issue\'s activity alike (ORR-927)', async () => {
        const ids: Record<string, string> = {}
        for (const p of ['through-store', 'through-api']) {
            const {id} = await store.createIssue(p, {title: 'Move it along', priority: 'P2'}, OWNER)
            ids[p] = id
            await store.updateIssue(p, id, {status: 'in-progress', title: 'Move it along now'}, SESSION)
            await store.updateIssue(p, id, {priority: null, labels: ['bug']})
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${p === 'through-store' ? 'STO' : 'API'}-91`, id)
        }
        const full = async (p: string) => (await store.issue(p, ids[p]!)).full_id
        const steps: [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>][] = [
            ['made, then changed by a session and an agent', p => viaStore(() => store.listActivity(p, ids[p]!)), () => viaApi('GET', `/issues/${ids['through-api']}/activity`)],
            ['by an id it had before', p => viaStore(() => store.listActivity(p, 'X-91'.replace('X', p === 'through-store' ? 'STO' : 'API'))), () => viaApi('GET', '/issues/API-91/activity')],
            ['by its full id', async p => viaStore(async () => store.listActivity(p, await full(p))), async () => viaApi('GET', `/issues/${await full('through-api')}/activity`)],
            ['an issue that isn\'t there', p => viaStore(() => store.listActivity(p, 'X-404')), () => viaApi('GET', '/issues/X-404/activity')],
            ['a project that isn\'t there', () => viaStore(() => store.listActivity('nowhere', 'X-1')), () => viaApi('GET', '/issues/X-1/activity', undefined, AGENT, 'nowhere')],
        ]
        for (const [name, ts, rs] of steps) await both(name, ts, rs)
        // The steps compared something: the changes are there, a value cleared with no `after`.
        const {body} = await viaApi('GET', `/issues/${ids['through-api']}/activity`)
        expect(body).toEqual(expect.arrayContaining([expect.objectContaining({field: 'status', after: 'in-progress', session_name: expect.any(String)})]))
        expect((body as {field: string, after?: string}[]).find(e => e.field === 'priority' && e.after === undefined)).toBeDefined()
    })

    it('makes and deletes comments alike, and passes a new one on to the sessions and the bell as the store does (ORR-927)', async () => {
        const key = (p: string) => p === 'through-store' ? 'STO' : 'API'
        const ids: Record<string, string> = {}
        for (const p of ['through-store', 'through-api']) {
            ids[p] = (await store.createIssue(p, {title: 'Weigh the gears'}, OWNER)).id
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${key(p)}-96`, ids[p])
        }
        const since = async () => ({
            signal: (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM signals'))?.n ?? 0,
            change: (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0,
        })
        const start = await since()
        const path = (p: string) => `/issues/${ids[p]}/comments`
        const assignee = (p: string) => viaStore(async () => ({assignee: (await store.issue(p, ids[p]!)).assignee ?? null}))
        const nth = async (p: string, n: number) => (await store.listComments(p, ids[p]!)).at(n)!.id
        // A comment's id is in a refusal's words, and ids differ between the two projects.
        const masked = async (outcome: Promise<Outcome>) => JSON.parse(JSON.stringify(await outcome).replace(/comment \d+/g, 'comment <n>')) as Outcome
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const make = (name: string, body: unknown, actor: Actor): Step =>
            [name, p => viaStore(() => store.createComment(p, ids[p]!, body, actor), 201), () => viaApi('POST', path('through-api'), body, actor)]
        const drop = (name: string, which: (p: string) => Promise<number>, actor: Actor): Step =>
            [name, p => masked(viaStore(async () => store.deleteComment(p, ids[p]!, await which(p), actor))), async () => masked(viaApi('DELETE', `${path('through-api')}/${await which('through-api')}`, undefined, actor))]
        const edit = (name: string, which: (p: string) => Promise<number>, body: unknown, actor: Actor): Step =>
            [name, p => masked(viaStore(async () => store.updateComment(p, ids[p]!, await which(p), body, actor))), async () => masked(viaApi('PATCH', `${path('through-api')}/${await which('through-api')}`, body, actor))]
        const steps: Step[] = [
            make('a session\'s word', {body: 'Started on it.'}, SESSION),
            make('an agent\'s ask, which the owner then has', {body: 'Which gear?', asks: 'decision'}, SESSION),
            ['the issue, the owner\'s', p => assignee(p), () => assignee('through-api')],
            make('the owner\'s answer, which gives it back', {body: 'The brass one.'}, OWNER),
            ['the issue, the agent\'s again', p => assignee(p), () => assignee('through-api')],
            make('asking nothing', {body: 'Noted.', asks: null}, AGENT),
            make('asking for feedback', {body: 'Look at it?', asks: 'feedback'}, AGENT),
            make('nothing in it', {body: '  '}, SESSION),
            make('no body', {asks: 'decision'}, SESSION),
            make('several problems', {body: 3, asks: 'maybe', bogus: true}, SESSION),
            make('not an object', ['Started.'], SESSION),
            ['by an id it had before', p => viaStore(() => store.createComment(p, `${key(p)}-96`, {body: 'Aliased.'}, SESSION), 201), () => viaApi('POST', '/issues/API-96/comments', {body: 'Aliased.'}, SESSION)],
            ['on an issue that isn\'t there', p => viaStore(() => store.createComment(p, 'X-404', {body: 'Hm.'}, SESSION)), () => viaApi('POST', '/issues/X-404/comments', {body: 'Hm.'}, SESSION)],
            ['the comments', p => viaStore(() => store.listComments(p, ids[p]!)), () => viaApi('GET', path('through-api'))],
            ['the activity', p => viaStore(() => store.listActivity(p, ids[p]!)), () => viaApi('GET', `/issues/${ids['through-api']}/activity`)],
            edit('a session\'s own, reworded', p => nth(p, 0), {body: 'Started on it, gears first.'}, SESSION),
            edit('the owner\'s, by a session', p => nth(p, 2), {body: 'The tin one.'}, SESSION),
            // The owner's new words go to the session on the issue too, as it may have read the first ones.
            edit('the owner\'s, reworded by them', p => nth(p, 2), {body: 'The brass one, polished.'}, OWNER),
            edit('the owner\'s, the same words again', p => nth(p, 2), {body: 'The brass one, polished.'}, OWNER),
            edit('asking nothing now', p => nth(p, 1), {asks: null}, SESSION),
            edit('nothing sent', p => nth(p, 0), {}, SESSION),
            edit('a blank body and a bad ask', p => nth(p, 0), {body: ' ', asks: 'maybe'}, SESSION),
            edit('one that isn\'t there', async () => 99_999_999, {body: 'Hm.'}, SESSION),
            ['the comments, edited', p => viaStore(() => store.listComments(p, ids[p]!)), () => viaApi('GET', path('through-api'))],
            drop('the owner\'s, by a session', p => nth(p, 2), SESSION),
            drop('a session\'s', p => nth(p, 0), SESSION),
            drop('one that isn\'t there', async () => 99_999_999, SESSION),
            drop('the owner\'s, by them', p => nth(p, 1), OWNER),
            ['the comments at the end', p => viaStore(() => store.listComments(p, ids[p]!)), () => viaApi('GET', path('through-api'))],
        ]
        for (const [name, ts, rs] of steps) await both(name, ts, rs)
        // The same signals for the sessions, and the same rows in the outbox, the bell's notices among them.
        const signals = async (p: string) => await store.db.all('SELECT issue, kind, note, target, person, created_by, owned FROM signals WHERE project = ? AND id > ? ORDER BY id', p, start.signal)
        expect(same({status: 0, body: await signals('through-api'), changed: [], told: [], settings: false}, 'through-api'))
            .toEqual(same({status: 0, body: await signals('through-store'), changed: [], told: [], settings: false}, 'through-store'))
        expect((await signals('through-api') as {note: string}[]).map(signal => signal.note)).toContain('(Edited: this replaces their earlier comment.)\n\nThe brass one, polished.')
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start.change))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        // The ask moved the unassigned issue to the owner (`owner`, as nobody here has given their name).
        const issue = ids['through-api']!.replace('API', 'KEY')
        expect(await rows('through-api')).toEqual(expect.arrayContaining(['comment.asks {"to":"decision"}', 'issue.assignee {"to":"owner"}', `notice {"issue":"${issue}"}`, 'signal ']))
    })

    it('reads milestones and releases alike, a shared release and every project\'s too (ORR-926)', async () => {
        const read = (name: string, ts: (p: string) => Promise<unknown>, path: (p: string) => string | Promise<string>, project?: string) =>
            both(name, p => viaStore(() => ts(project ?? p)), async () => viaApi('GET', await path('through-api'), undefined, AGENT, project ?? 'through-api'))
        // Before either has milestones or releases.
        await read('no milestones yet', p => store.listMilestones(p), () => '/milestones')
        await read('releases off', p => store.listReleases(p), () => '/releases')
        await read('a release with releases off', p => store.release(p, '1.0.0'), () => '/releases/1.0.0')
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            const key = p === 'through-store' ? 'STO' : 'API'
            await store.updateProject(p, {release_mode: 'own'}, OWNER)
            for (const version of ['2.0.0', '2.1.0']) await store.createRelease(p, {version, branch: `release/${version}`, notes: 'Hinges, at last.'}, OWNER)
            await store.updateRelease(p, '2.0.0', {shipped_on: '2026-11-01'}, OWNER)
            const {id: frame} = await store.createMilestone(p, {title: 'The frame', summary: 'Square and glued', priority: 'P1'}, OWNER)
            const {id: finish} = await store.createMilestone(p, {title: 'The finish'})
            await store.createMilestone(p, {title: 'Nothing yet'}, OWNER)
            const {id: legs} = await store.createIssue(p, {title: 'Cut the legs', milestone: frame, release: '2.0.0'}, OWNER)
            await store.createIssue(p, {title: 'Square them', parent: legs, status: 'done'}, OWNER)
            await store.createIssue(p, {title: 'Glue them', parent: legs, status: 'started', release: '2.1.0'}, OWNER)
            await store.createIssue(p, {title: 'Oil it', milestone: finish, release: '2.1.0', status: 'todo'}, OWNER)
            await store.createIssue(p, {title: 'Stain it?', milestone: finish, proposal: 'pending'})
            await store.createIssue(p, {title: 'Loose end', release: '2.1.0'}, OWNER)
            await store.db.run('INSERT INTO milestone_aliases (project, alias, milestone) VALUES (?, ?, ?)', p, '77', frame)
            // A project drawing on this one's releases, with an issue of its own set for one.
            const drawing = `${p}-drawing`
            await store.createProject({name: drawing, key: `${key}D`})
            await store.updateProject(drawing, {releases_from: p}, OWNER)
            await store.createIssue(drawing, {title: 'Ship the legs too', release: '2.1.0', status: 'done'}, OWNER)
            ids[p] = {frame, finish, legs, uid: (await store.milestone(p, frame)).full_id.split('-').at(-1)!}
        }
        await read('the milestones, rolled up', p => store.listMilestones(p), () => '/milestones')
        await read('a milestone with its issues', p => store.milestone(p, ids[p]!.frame!), p => `/milestones/${ids[p]!.frame}`)
        await read('one with a proposal', p => store.milestone(p, ids[p]!.finish!), p => `/milestones/${ids[p]!.finish}`)
        await read('by an id it had before', p => store.milestone(p, '77'), () => '/milestones/77')
        await read('by its full id', p => store.milestone(p, `mls-${ids[p]!.frame}-${ids[p]!.uid}`), p => `/milestones/mls-${ids[p]!.frame}-${ids[p]!.uid}`)
        await read('by its full id from before', p => store.milestone(p, `chk-${ids[p]!.frame}-${ids[p]!.uid}`), p => `/milestones/chk-${ids[p]!.frame}-${ids[p]!.uid}`)
        await read('a milestone that isn\'t there', p => store.milestone(p, '99'), () => '/milestones/99')
        await read('milestones in a project that isn\'t there', p => store.listMilestones(p), () => '/milestones', 'nowhere')
        await read('the releases, counting the project drawing on them', p => store.listReleases(p), () => '/releases')
        await read('a release, with its part in each project', p => store.release(p, '2.1.0'), () => '/releases/2.1.0')
        await read('a shipped one', p => store.release(p, '2.0.0'), () => '/releases/2.0.0')
        await read('a release there isn\'t', p => store.release(p, '9.9'), () => '/releases/9.9')
        await both('releases from the project drawing on them', p => viaStore(() => store.listReleases(`${p}-drawing`)), () => viaApi('GET', '/releases', undefined, AGENT, 'through-api-drawing'))
        await both('a release from the project drawing on it', p => viaStore(() => store.release(`${p}-drawing`, '2.1.0')), () => viaApi('GET', '/releases/2.1.0', undefined, AGENT, 'through-api-drawing'))
        await both('one its source hasn\'t', p => viaStore(() => store.release(`${p}-drawing`, '9.9')), () => viaApi('GET', '/releases/9.9', undefined, AGENT, 'through-api-drawing'))
        await read('releases in a project that isn\'t there', p => store.listReleases(p), () => '/releases', 'nowhere')
        // Every project's: one list for the orrery, so the same either way.
        expect(await viaApi('GET', '/api/releases')).toEqual(await viaStore(() => store.allReleases()))
        // Every project, listed with its counts (ORR-997): one list for the orrery too, with docs, sections, releases
        // drawn on and milestones by now. Asking for their boards stays with the Nuxt server.
        await store.createDoc('through-api', {title: 'Joinery', body: 'Mortise first.', section: 'Shop'})
        await store.db.run("INSERT INTO settings (key, value) VALUES ('starts', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify({max: 2}))
        expect(await viaApi('GET', '/api/projects')).toEqual(await viaStore(() => store.listProjects()))
        expect(domainOf('GET', '/api/projects')).toBe('projects, listed')
        expect(domainOf('POST', '/api/projects')).toBe('a project, made')
        // One project with its board (ORR-1006), whole and trimmed as the page's reads ask, without the events stream's
        // `rev`, which only the Nuxt server has: so the router doesn't send it on yet.
        const board = await store.project('through-api')
        expect((await viaApi('GET', '/api/projects/through-api')).body).toEqual(JSON.parse(JSON.stringify(board)))
        for (const query of ['notes=0', 'closed=0', 'notes=0&closed=0']) {
            const lighter = query.includes('notes') ? withoutNotes(board) : board
            const trimmed = query.includes('closed') ? withoutClosed(lighter) : lighter
            expect((await viaApi('GET', `/api/projects/through-api?${query}`)).body, query).toEqual(JSON.parse(JSON.stringify(trimmed)))
        }
        expect((await viaApi('GET', '/api/projects/nowhere')).status).toBe(404)
        expect(domainOf('GET', '/api/projects/through-api')).toBeUndefined()
        const listed = (await viaApi('GET', '/api/projects')).body as {id: string, milestones: number, docs: unknown[], starts?: unknown}[]
        expect(listed.find(p => p.id === 'through-api')).toMatchObject({milestones: 4, docs: expect.arrayContaining([expect.objectContaining({title: 'Joinery', section: 'Shop'})]), starts: {max: 2}})
        await store.db.run("DELETE FROM settings WHERE key = 'starts'")
        // The steps compared something.
        const frame = await viaApi('GET', `/milestones/${ids['through-api']!.frame}`)
        expect(frame.body).toMatchObject({column: 'in-progress', summary: 'Square and glued', aliases: ['77'], issues: [ids['through-api']!.legs]})
        const shared = await viaApi('GET', '/releases/2.1.0')
        expect(shared.body).toMatchObject({issues: 4, projects: [{project: 'through-api', issues: 3}, {project: 'through-api-drawing', issues: 1}]})
    })

    it('changes a project alike, its prompts the owner\'s and its releases moved as the store moves them (ORR-923)', async () => {
        for (const p of ['through-store', 'through-api']) {
            const key = p === 'through-store' ? 'STO' : 'API'
            await store.createProject({name: `${p}-bench`, key: `${key}K`})
            await store.createProject({name: `${p}-src`, key: `${key}S`})
        }
        const on = (p: string) => `${p}-bench`
        const src = (p: string) => `${p}-src`
        const api = (body: unknown, actor: Actor = AGENT, project = 'through-api-bench') => viaApi('PATCH', '', body, actor, project)
        const change = (name: string, body: (p: string) => unknown, actor: Actor = AGENT, of = on): [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>] =>
            [name, p => viaStore(() => store.updateProject(of(p), body(p), actor)), () => api(body('through-api'), actor, of('through-api'))]
        const both2 = (name: string, step: (p: string) => Promise<unknown>): [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>] =>
            [name, p => viaStore(() => step(p)), () => viaStore(() => step('through-api'))]
        const steps: [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>][] = [
            change('renamed, described, with an icon, a tint and a repo', () => ({name: ' Workbench ', description: 'Tools', icon: 'wrench', icon_color: 'teal', repo: 'https://github.com/ada/bench'})),
            change('a hex tint, and the description cleared', () => ({icon_color: '#3B82f6', description: null, key: 'BENCH'})),
            change('nothing sent', () => ({})),
            change('its own id again', p => ({id: on(p)})),
            change('another id', () => ({id: 'elsewhere'})),
            change('bad fields', () => ({icon: 'Wrench!', icon_color: 'pink', repo: 'ftp://x/', key: 'lower', release_mode: 'all', colour: 'red'})),
            change('one bad field', () => ({name: ' '})),
            change('a name that can\'t be null', () => ({name: null})),
            change('not a list', () => ({muted: 'x', instructions: [{text: ''}]}), OWNER),
            change('its prompts, by a session', () => ({focus_prompt: 'Focus.', muted: ['x']})),
            change('its prompts, by the owner', () => ({focus_prompt: '  Focus on it. ', milestone_prompt: ' ', instructions: [{id: 'a1', text: ' Be brief ', on: false}, {id: 'b2', text: 'Test first'}], muted: ['x', ' x', 'y']}), OWNER),
            change('its prompts cleared', () => ({focus_prompt: null, instructions: null, muted: null}), OWNER),
            change('releases from one without any', p => ({releases_from: src(p)})),
            change('releases from itself', p => ({releases_from: on(p)})),
            change('releases from one that isn\'t there', () => ({releases_from: 'nowhere'})),
            change('shared, from nobody', () => ({release_mode: 'shared'})),
            change('its own, from another', p => ({release_mode: 'own', releases_from: src(p)})),
            change('the source with releases of its own', () => ({release_mode: 'own'}), OWNER, src),
            both2('a release there, and one of its own', async p => {
                await store.createRelease(src(p), {version: '1.0.0'}, OWNER)
                await store.updateProject(on(p), {release_mode: 'own'}, OWNER)
                return await store.createRelease(on(p), {version: '0.1.0'}, OWNER)
            }),
            change('to shared with releases of its own', p => ({releases_from: src(p)})),
            change('to none with releases of its own', () => ({release_mode: 'none'})),
            both2('its release gone, an issue set for the source\'s', async p => {
                await store.deleteRelease(on(p), '0.1.0', OWNER)
                await store.updateProject(on(p), {releases_from: src(p)}, OWNER)
                return await store.createIssue(on(p), {title: 'Ship it', release: '1.0.0'}, OWNER)
            }),
            change('the source, leaving its own while drawn on', () => ({release_mode: 'none'}), OWNER, src),
            change('back on its own, the source\'s release let go', () => ({releases_from: null})),
            change('shared again, then none', p => ({release_mode: 'shared', releases_from: src(p)})),
            change('none', () => ({release_mode: 'none'})),
            change('not an object', () => ['name']),
            change('one that isn\'t there', () => ({name: 'x'}), AGENT, () => 'nowhere'),
        ]
        // Each project's own key and uid differ, so they're left out of what's compared.
        const own = (outcome: Outcome): Outcome => {
            const body = outcome.body as Record<string, unknown> | null
            return body && typeof body === 'object' && 'uid' in body ? {...outcome, body: {...body, key: '<key>', uid: '<uid>'}} : outcome
        }
        const outcomes: Outcome[] = []
        for (const [name, ts, rs] of steps) outcomes.push(await both(name, async p => own(await ts(p)), async () => own(await rs())))
        // The steps compared something.
        expect(outcomes[0]).toMatchObject({status: 200, body: {name: 'Workbench', icon: 'wrench', board: {milestones: []}}, changed: ['through-api-bench']})
        expect(outcomes[5]).toMatchObject({status: 400, body: {message: '6 problems in the body'}})
        expect(outcomes[9]).toMatchObject({status: 403})
        expect(outcomes[10]).toMatchObject({status: 200, body: {focus_prompt: 'Focus on it.', muted: ['x', 'y']}})
        expect(outcomes[10]!.body).not.toHaveProperty('milestone_prompt')
        expect(outcomes[19]).toMatchObject({status: 409})
        expect(outcomes[23]).toMatchObject({status: 200, body: {release_mode: 'own'}, changed: ['through-api-bench', 'through-api-src']})
        expect((outcomes[23]!.body as {board: {milestones: {tasks: {release?: string}[]}[]}}).board.milestones[0]!.tasks[0]).not.toHaveProperty('release')
        expect(domainOf('PATCH', '/api/projects/p')).toBe('a project, changed')
        for (const method of ['GET', 'DELETE']) expect(domainOf(method, '/api/projects/p'), method).toBeUndefined()
    })

    it('makes a project alike, its id and key from its name, refusing what the store refuses (ORR-1002)', async () => {
        const make = (name: string, body: (p: string) => unknown, actor: Actor = AGENT): [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>] =>
            [name, p => viaStore(() => store.createProject(body(p), actor), 201), () => viaApi('POST', '/api/projects', body('through-api'), actor)]
        const steps = [
            make('a name only', p => ({name: ` ${p} Made `})),
            make('the same again', p => ({name: `${p} made`})),
            make('every field, the owner\'s', p => ({
                name: 'Greenhouse', id: `${p}-green`, description: 'Plants', icon: 'sun', icon_color: '#3B82f6', repo: 'https://github.com/ada/green',
                focus_prompt: ' Focus. ', milestone_prompt: ' ', instructions: [{id: 'a1', text: ' Be brief ', on: false}], muted: ['x', ' x'],
            }), OWNER),
            make('its prompts, by a session', p => ({name: 'Quiet', id: `${p}-quiet`, muted: ['x']})),
            make('a key ids start with', p => ({name: 'Plans', id: `${p}-plans`, key: 'MLS'})),
            make('a name keyed past those', p => ({name: 'Epcot', id: `${p}-epcot`})),
            make('a name with no id in it', () => ({name: '!!!'})),
            make('no name', () => ({})),
            make('bad fields', () => ({name: 'y', id: 'Not An Id', release_mode: 'all', colour: 1})),
            make('releases from one without any', p => ({name: 'Z', id: `${p}-z`, releases_from: `${p}-green`})),
            make('releases of its own', p => ({name: 'Own', id: `${p}-own`, release_mode: 'own'})),
            make('releases from one with its own', p => ({name: 'Drawn', id: `${p}-drawn`, releases_from: `${p}-own`})),
            make('shared, from nobody', p => ({name: 'S', id: `${p}-s`, release_mode: 'shared'})),
            make('its own, from another', p => ({name: 'T', id: `${p}-t`, release_mode: 'own', releases_from: `${p}-own`})),
            make('not an object', () => ['name']),
        ]
        // Each project's uid differs, so it's left out of what's compared; its key is made the same way on both.
        const own = (outcome: Outcome): Outcome => {
            const body = outcome.body as Record<string, unknown> | null
            return body && typeof body === 'object' && 'uid' in body ? {...outcome, body: {...body, uid: '<uid>'}} : outcome
        }
        const outcomes: Outcome[] = []
        for (const [name, ts, rs] of steps) outcomes.push(await both(name, async p => own(await ts(p)), async () => own(await rs())))
        // The steps compared something.
        expect(outcomes[0]).toMatchObject({status: 201, body: {id: 'through-api-made', name: 'through-api Made', key: 'THR', release_mode: 'none', board: {milestones: []}}, changed: ['through-api-made']})
        expect(outcomes[1]).toMatchObject({status: 409})
        expect(outcomes[2]).toMatchObject({status: 201, body: {key: 'GRE', icon_color: '#3B82f6', focus_prompt: 'Focus.', muted: ['x'], protected: true}})
        expect(outcomes[2]!.body).not.toHaveProperty('milestone_prompt')
        expect(outcomes[3]).toMatchObject({status: 403})
        expect(outcomes[4]).toMatchObject({status: 400})
        expect(outcomes[5]).toMatchObject({status: 201, body: {key: 'EPCO'}})
        expect(outcomes[8]).toMatchObject({status: 400, body: {message: '3 problems in the body'}})
        expect(outcomes[11]).toMatchObject({status: 201, body: {release_mode: 'shared', releases_from: 'through-api-own'}})
        expect(domainOf('POST', '/api/projects')).toBe('a project, made')
        expect(domainOf('POST', '/api/projects/upload')).toBeUndefined()
    })

    it('makes, changes, refuses and deletes milestones alike, and tells what each did (ORR-974)', async () => {
        for (const p of ['through-store', 'through-api']) await store.createProject({name: `${p}-plans`, key: p === 'through-store' ? 'STOP' : 'APIP'})
        const on = (p: string) => `${p}-plans`
        const api = (method: string, path: string, body?: unknown, actor: Actor = AGENT, project = 'through-api-plans') => viaApi(method, path, body, actor, project)
        const steps: [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>][] = [
            ['the owner\'s', p => viaStore(() => store.createMilestone(on(p), {title: '  Frame  '}, OWNER), 201), () => api('POST', '/milestones', {title: '  Frame  '}, OWNER)],
            ['a session\'s, placed and summed up', p => viaStore(() => store.createMilestone(on(p), {title: 'Finish', summary: 'Oil and wax', priority: 'P1', position: 7}, SESSION), 201),
                () => api('POST', '/milestones', {title: 'Finish', summary: 'Oil and wax', priority: 'P1', position: 7}, SESSION)],
            ['no title', p => viaStore(() => store.createMilestone(on(p), {summary: 'x'})), () => api('POST', '/milestones', {summary: 'x'})],
            ['an empty title, a bad priority and a field it doesn\'t take', p => viaStore(() => store.createMilestone(on(p), {title: ' ', priority: 'P9', colour: 'red'})),
                () => api('POST', '/milestones', {title: ' ', priority: 'P9', colour: 'red'})],
            ['in a project that isn\'t there', () => viaStore(() => store.createMilestone('nowhere', {title: 'x'})), () => api('POST', '/milestones', {title: 'x'}, AGENT, 'nowhere')],
            ['renamed, its summary and priority cleared, moved', p => viaStore(() => store.updateMilestone(on(p), '2', {title: ' Finishing ', summary: null, priority: null, position: 0})),
                () => api('PATCH', '/milestones/2', {title: ' Finishing ', summary: null, priority: null, position: 0})],
            ['nothing changed', p => viaStore(() => store.updateMilestone(on(p), '1', {})), () => api('PATCH', '/milestones/1', {})],
            ['a title that can\'t be null', p => viaStore(() => store.updateMilestone(on(p), '1', {title: null})), () => api('PATCH', '/milestones/1', {title: null})],
            ['one that isn\'t there', p => viaStore(() => store.updateMilestone(on(p), '9', {title: 'x'})), () => api('PATCH', '/milestones/9', {title: 'x'})],
            ['by an id it had before', async p => {
                await store.db.run('INSERT INTO milestone_aliases (project, alias, milestone) VALUES (?, ?, ?)', on(p), '77', '2')
                return viaStore(() => store.updateMilestone(on(p), '77', {summary: 'Waxed'}))
            }, async () => {
                await store.db.run('INSERT INTO milestone_aliases (project, alias, milestone) VALUES (?, ?, ?)', 'through-api-plans', '77', '2')
                return api('PATCH', '/milestones/77', {summary: 'Waxed'})
            }],
            ['the owner\'s, deleted by a session', p => viaStore(() => store.deleteMilestone(on(p), '1', SESSION)), () => api('DELETE', '/milestones/1', undefined, SESSION)],
            ['an issue in one', p => viaStore(() => store.createIssue(on(p), {title: 'Wax it', milestone: '2'}, OWNER), 201),
                () => viaStore(() => store.createIssue('through-api-plans', {title: 'Wax it', milestone: '2'}, OWNER), 201)],
            ['that one deleted, by an id it had', p => viaStore(() => store.deleteMilestone(on(p), '77', SESSION)), () => api('DELETE', '/milestones/77', undefined, SESSION)],
            ['its issue, in none now', p => viaStore(() => store.listIssues(on(p))), () => api('GET', '/issues')],
            ['the owner\'s, deleted by the owner', p => viaStore(() => store.deleteMilestone(on(p), '1', OWNER)), () => api('DELETE', '/milestones/1', undefined, OWNER)],
            ['one that isn\'t there, deleted', p => viaStore(() => store.deleteMilestone(on(p), '1', OWNER)), () => api('DELETE', '/milestones/1', undefined, OWNER)],
            ['a new one gets the next number', p => viaStore(() => store.createMilestone(on(p), {title: 'Ship'}), 201), () => api('POST', '/milestones', {title: 'Ship'})],
            ['the milestones at the end', p => viaStore(() => store.listMilestones(on(p))), () => api('GET', '/milestones')],
        ]
        const outcomes: Outcome[] = []
        for (const [name, ts, rs] of steps) outcomes.push(await both(name, ts, rs))
        // The steps compared something: what the API made, told and refused.
        expect(outcomes[1]).toMatchObject({status: 201, body: {id: '2', title: 'Finish', summary: 'Oil and wax', priority: 'P1'}, changed: ['through-api-plans'], told: ['milestone.created 2']})
        expect(outcomes[5]).toMatchObject({status: 200, body: {title: 'Finishing', position: 0}})
        expect(outcomes[5]!.body).not.toHaveProperty('summary')
        expect(outcomes[10]).toMatchObject({status: 403})
        expect(outcomes[12]).toMatchObject({status: 204, changed: ['through-api-plans']})
        expect(outcomes[13]!.body).toMatchObject([{title: 'Wax it', milestone: null}])
        expect(outcomes[16]).toMatchObject({status: 201, body: {id: '3'}})
    })

    it('makes, changes, freezes, ships, refuses and deletes releases alike, and tells what each did (ORR-974)', async () => {
        const on = (p: string) => `${p}-ships`
        const drawing = (p: string) => `${p}-ships-drawing`
        for (const p of ['through-store', 'through-api']) {
            await store.createProject({name: on(p), key: p === 'through-store' ? 'STOS' : 'APIS'})
            await store.createProject({name: drawing(p), key: p === 'through-store' ? 'STOX' : 'APIX'})
        }
        const api = (method: string, path: string, body?: unknown, actor: Actor = AGENT, project = 'through-api-ships') => viaApi(method, path, body, actor, project)
        const outcomes: Outcome[] = []
        const step = async (name: string, ts: (p: string) => Promise<Outcome>, rs: () => Promise<Outcome>) => outcomes.push(await both(name, ts, rs))
        await step('with releases off', p => viaStore(() => store.createRelease(on(p), {version: '1.0.0'})), () => api('POST', '/releases', {version: '1.0.0'}))
        for (const p of ['through-store', 'through-api']) {
            await store.updateProject(on(p), {release_mode: 'own'}, OWNER)
            await store.updateProject(drawing(p), {releases_from: on(p)}, OWNER)
        }
        await step('the owner\'s, with a branch to trim', p => viaStore(() => store.createRelease(on(p), {version: '1.0.0', branch: '  release/1.0  ', notes: 'Hinges.'}, OWNER), 201),
            () => api('POST', '/releases', {version: '1.0.0', branch: '  release/1.0  ', notes: 'Hinges.'}, OWNER))
        await step('a session\'s, shipped and placed', p => viaStore(() => store.createRelease(on(p), {version: '1.1.0', shipped_on: '2026-11-01', position: 5}, SESSION), 201),
            () => api('POST', '/releases', {version: '1.1.0', shipped_on: '2026-11-01', position: 5}, SESSION))
        await step('a third, at the top', p => viaStore(() => store.createRelease(on(p), {version: '2.0.0-rc.1', branch: null}), 201),
            () => api('POST', '/releases', {version: '2.0.0-rc.1', branch: null}))
        await step('a version taken', p => viaStore(() => store.createRelease(on(p), {version: '1.0.0'})), () => api('POST', '/releases', {version: '1.0.0'}))
        await step('an empty version, a day that isn\'t one and a field it doesn\'t take', p => viaStore(() => store.createRelease(on(p), {version: '', frozen_on: 'soon', colour: 1})),
            () => api('POST', '/releases', {version: '', frozen_on: 'soon', colour: 1}))
        await step('no version, and a place that isn\'t a number', p => viaStore(() => store.createRelease(on(p), {position: 'top', notes: 3})), () => api('POST', '/releases', {position: 'top', notes: 3}))
        await step('from a project drawing on it', p => viaStore(() => store.createRelease(drawing(p), {version: '3.0.0'})),
            () => api('POST', '/releases', {version: '3.0.0'}, AGENT, 'through-api-ships-drawing'))
        await step('frozen, its notes and branch cleared', p => viaStore(() => store.updateRelease(on(p), '1.0.0', {frozen_on: '2026-11-02', notes: null, branch: '  '})),
            () => api('PATCH', '/releases/1.0.0', {frozen_on: '2026-11-02', notes: null, branch: '  '}))
        await step('a new day on one frozen', p => viaStore(() => store.updateRelease(on(p), '1.0.0', {frozen_on: '2026-11-03'})), () => api('PATCH', '/releases/1.0.0', {frozen_on: '2026-11-03'}))
        await step('thawed and shipped, and moved', p => viaStore(() => store.updateRelease(on(p), '1.0.0', {frozen_on: null, shipped_on: '2026-11-04', position: 9})),
            () => api('PATCH', '/releases/1.0.0', {frozen_on: null, shipped_on: '2026-11-04', position: 9}))
        await step('unshipped', p => viaStore(() => store.updateRelease(on(p), '1.0.0', {shipped_on: null})), () => api('PATCH', '/releases/1.0.0', {shipped_on: null}))
        await step('its own version again', p => viaStore(() => store.updateRelease(on(p), '1.0.0', {version: '1.0.0'})), () => api('PATCH', '/releases/1.0.0', {version: '1.0.0'}))
        await step('a new version', p => viaStore(() => store.updateRelease(on(p), '1.0.0', {version: '1.0.1'})), () => api('PATCH', '/releases/1.0.0', {version: '1.0.1'}))
        await step('one that isn\'t there', p => viaStore(() => store.updateRelease(on(p), '9.9.9', {notes: 'x'})), () => api('PATCH', '/releases/9.9.9', {notes: 'x'}))
        await step('changed from a project drawing on it', p => viaStore(() => store.updateRelease(drawing(p), '1.0.0', {notes: 'x'})),
            () => api('PATCH', '/releases/1.0.0', {notes: 'x'}, AGENT, 'through-api-ships-drawing'))
        for (const p of ['through-store', 'through-api']) {
            await store.createIssue(on(p), {title: 'Oil it', release: '1.1.0'}, OWNER)
            await store.createIssue(drawing(p), {title: 'Oil theirs', release: '1.1.0'}, OWNER)
        }
        await step('the owner\'s, deleted by a session', p => viaStore(() => store.deleteRelease(on(p), '1.0.0', SESSION)), () => api('DELETE', '/releases/1.0.0', undefined, SESSION))
        await step('one with issues, here and drawing on it', p => viaStore(() => store.deleteRelease(on(p), '1.1.0', SESSION)), () => api('DELETE', '/releases/1.1.0', undefined, SESSION))
        await step('its issues, set for none', p => viaStore(() => store.listIssues(on(p))), () => api('GET', '/issues'))
        await step('theirs too', p => viaStore(() => store.listIssues(drawing(p))), () => api('GET', '/issues', undefined, AGENT, 'through-api-ships-drawing'))
        await step('one that isn\'t there, deleted', p => viaStore(() => store.deleteRelease(on(p), '1.1.0', OWNER)), () => api('DELETE', '/releases/1.1.0', undefined, OWNER))
        await step('the releases at the end', p => viaStore(() => store.listReleases(on(p))), () => api('GET', '/releases'))
        // The steps compared something: what the API made, told and refused.
        expect(outcomes[0]).toMatchObject({status: 400})
        expect(outcomes[1]).toMatchObject({status: 201, body: {version: '1.0.0', branch: 'release/1.0'}, changed: ['through-api-ships', 'through-api-ships-drawing'], told: ['release.created 1.0.0']})
        expect(outcomes[4]).toMatchObject({status: 409})
        expect(outcomes[8]).toMatchObject({status: 200, told: ['release.frozen 1.0.0']})
        expect(outcomes[9]).toMatchObject({status: 200, told: []})
        expect(outcomes[10]).toMatchObject({status: 200, told: ['release.thawed 1.0.0', 'release.shipped 1.0.0']})
        expect(outcomes[11]).toMatchObject({status: 200, told: ['release.unshipped 1.0.0']})
        expect(outcomes[16]).toMatchObject({status: 403})
        expect(outcomes[17]).toMatchObject({status: 204, told: ['release.deleted 1.1.0']})
        expect(outcomes[19]!.body).toMatchObject([{title: 'Oil theirs'}])
        expect((outcomes[19]!.body as object[])[0]).not.toHaveProperty('release')
        expect(outcomes[21]!.body).toMatchObject([{version: '2.0.0-rc.1'}, {version: '1.0.0'}])
    })

    it('reads the schedules alike: a project\'s, one with its runs, every project\'s and those across (ORR-930)', async () => {
        const schedules = new Schedules(store)
        const on = (p: string) => `${p}-timed`
        for (const p of ['through-store', 'through-api']) await store.createProject({name: on(p), key: p === 'through-store' ? 'STOT' : 'APIT'})
        await both('none yet', p => viaStore(() => schedules.list(on(p))), () => viaApi('GET', '/schedules', undefined, AGENT, 'through-api-timed'))
        const ids: Record<string, number[]> = {}
        for (const p of ['through-store', 'through-api']) {
            const made = [
                await schedules.create(on(p), {title: 'Water', cron: '0 9 * * *', timezone: 'Europe/Oslo', labels: ['garden'], priority: 'P2', notes: 'The beds.'}, OWNER),
                await schedules.create(on(p), {title: 'air', cron: '0 7 * * 1', timezone: 'UTC', enabled: false}, OWNER),
                await schedules.create(on(p), {title: 'Once', at: '2099-01-01T09:00:00Z', ask: true}),
                await schedules.create(on(p), {title: 'Also once', at: '2099-01-01T09:00:00Z'}),
                await schedules.create(on(p), {kind: 'message', title: 'Triage', notes: 'Read GitHub.', on: 'issue.status', on_filter: {to: 'in-review'}, untrusted: true}, OWNER),
            ]
            await schedules.runNow(on(p), made[0]!.id, OWNER)
            await schedules.runNow(on(p), made[0]!.id, OWNER)
            await store.db.run('INSERT INTO schedule_held (schedule, subject, event, at) VALUES (?, ?, ?, ?)', made[4]!.id, 'KEY-1', '{}', new Date().toISOString())
            ids[p] = made.map(s => s.id)
        }
        await both('a project\'s, soonest first and none due last', p => viaStore(() => schedules.list(on(p))), () => viaApi('GET', '/schedules', undefined, AGENT, 'through-api-timed'))
        for (const at of [0, 1, 4]) {
            await both(`schedule ${at} with its runs`, p => viaStore(() => schedules.get(on(p), ids[p]![at]!)), () => viaApi('GET', `/schedules/${ids['through-api']![at]}`, undefined, AGENT, 'through-api-timed'))
        }
        const uid = (await store.settings()).uid
        await both('by its full id', p => viaStore(() => schedules.get(on(p), ids[p]![0]!)), () => viaApi('GET', `/schedules/sch-${ids['through-api']![0]}-${uid}`, undefined, AGENT, 'through-api-timed'))
        await both('one that isn\'t there', p => viaStore(() => schedules.get(on(p), 9999)), () => viaApi('GET', '/schedules/9999', undefined, AGENT, 'through-api-timed'))
        expect((await viaApi('GET', '/schedules/nope', undefined, AGENT, 'through-api-timed'))).toMatchObject({status: 404, body: {message: 'No schedule nope'}})
        await both('in a project that isn\'t there', () => viaStore(() => schedules.list('nowhere')), () => viaApi('GET', '/schedules', undefined, AGENT, 'nowhere'))
        // The orrery's own lists hold both projects' schedules, so they're compared whole.
        await schedules.createAcross({projects: [on('through-store'), on('through-api')], title: 'Weekly look', cron: '0 8 * * 1', timezone: 'UTC', enabled: false}, OWNER)
        await schedules.createAcross({projects: '*', skip: ['through-store'], title: 'Daily', on: 'issue.created'}, OWNER)
        for (const [path, read] of [['/api/schedules', () => schedules.list()], ['/api/schedules/across', () => schedules.listAcross()]] as const) {
            const [api, kept] = [await viaApi('GET', path), JSON.parse(JSON.stringify(await read()))]
            expect(api.status, path).toBe(200)
            expect(api.body, path).toEqual(kept)
        }
        const all = (await viaApi('GET', '/api/schedules')).body as {title: string, next_run?: string}[]
        const firstPaused = all.findIndex(s => !s.next_run)
        expect(firstPaused).toBeGreaterThan(0)
        expect(all.slice(firstPaused).every(s => !s.next_run)).toBe(true)
        expect(domainOf('GET', '/api/schedules/across')).toBe('schedules, reading')
        for (const [method, path] of [['POST', '/api/schedules'], ['PATCH', '/api/projects/p/schedules/3'], ['POST', '/api/projects/p/schedules/3/run'], ['POST', '/api/projects/p/schedules/enabled'], ['DELETE', '/api/schedules/across/2']])
            expect(domainOf(method!, path!), `${method} ${path}`).toBeUndefined()
    })

    it('keeps a pull request on the issues it names alike, as the poll does (ORR-952)', async () => {
        const pulls = new Pulls(store, async () => { throw new Error('no GitHub here') })
        const on = (p: string) => `${p}-kept`
        const ids: Record<string, {lid: string, hinge: string, old: string, shipped: string}> = {}
        for (const p of ['through-store', 'through-api']) {
            await store.createProject({name: on(p), key: p === 'through-store' ? 'STOK' : 'APIK'})
            await store.updateProject(on(p), {release_mode: 'own'}, OWNER)
            await store.createRelease(on(p), {version: '2.0.0', branch: 'release/2.0'}, OWNER)
            const lid = (await store.createIssue(on(p), {title: 'Fit the lid'}, OWNER)).id
            const hinge = (await store.createIssue(on(p), {title: 'Fit the hinge'}, OWNER)).id
            const shipped = (await store.createIssue(on(p), {title: 'Ship the box', release: '2.0.0'}, OWNER)).id
            const old = `${p === 'through-store' ? 'STOK' : 'APIK'}-77`
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', on(p), old, hinge)
            ids[p] = {lid, hinge, old, shipped}
        }
        const pull = (p: string, number: number, names: string[], extra: Record<string, unknown> = {}) => ({number, title: `Pull ${number}`, url: `https://github.com/ada/${on(p)}/pull/${number}`,
            branch: `feat/pull-${number}`, base: 'v1.0.0-rc.18', author: 'ada', merged: false, closed: false, merged_at: null, created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z', names, ...extra})
        const keep = (name: string, made: (p: string) => ReturnType<typeof pull>) => both(name,
            p => viaStore(() => pulls.remember(`ada/${on(p)}`, [on(p)], made(p))),
            () => {
                const {number, ...rest} = made('through-api')
                return viaApi('PUT', `/api/pulls/ada/${on('through-api')}/${number}`, {projects: [on('through-api')], ...rest}, AGENT)
            })
        const kept = () => both('what\'s kept', p => viaStore(() => store.db.all(
            'SELECT issue, number, title, url, branch, base, author, state, merged_at, created_at, updated_at, risk FROM issue_pulls WHERE project = ? ORDER BY issue, number', on(p))),
            () => viaStore(() => store.db.all('SELECT issue, number, title, url, branch, base, author, state, merged_at, created_at, updated_at, risk FROM issue_pulls WHERE project = ? ORDER BY issue, number', on('through-api'))))
        const outcomes = [
            await keep('on the issue it names', p => pull(p, 1, [ids[p]!.lid])),
            await keep('on two, one by an id it had', p => pull(p, 2, [ids[p]!.lid, ids[p]!.old])),
            await keep('naming one that isn\'t there', p => pull(p, 3, ['NOPE-1'])),
            await kept(),
            await keep('no longer naming the lid, and merged', p => pull(p, 2, [ids[p]!.hinge], {merged: true, merged_at: '2026-11-05T12:00:00Z', updated_at: '2026-11-05T12:00:00Z'})),
            await keep('a release PR, on its release\'s issues', p => pull(p, 4, [], {branch: 'release/2.0'})),
            await keep('closed', p => pull(p, 1, [ids[p]!.lid], {closed: true, updated_at: '2026-11-05T13:00:00Z'})),
            await kept(),
        ]
        expect(outcomes[0]).toMatchObject({status: 204})
        expect(outcomes[3]!.body).toHaveLength(3)
        expect(outcomes[7]!.body).toEqual(expect.arrayContaining([expect.objectContaining({number: 2, state: 'merged'}), expect.objectContaining({number: 4}), expect.objectContaining({number: 1, state: 'closed'})]))
        expect(outcomes[7]!.body).toHaveLength(3)
        // Refused as a body the poll would never send.
        const refused = await viaApi('PUT', `/api/pulls/ada/${on('through-api')}/5`, {projects: 'all', names: [1], title: 2, colour: 'red'})
        expect(refused).toMatchObject({status: 400})
        expect((refused.body as {data: {problems: string[]}}).data.problems).toEqual(expect.arrayContaining(['unknown field "colour"; this takes projects, names, title, url, branch, base, author, merged, closed, merged_at, created_at, updated_at']))
        expect(domainOf('PUT', `/api/pulls/ada/${on('through-api')}/5`)).toBeUndefined()
    })

    it('keeps a repo\'s poll, its failure, its history page and what it lets go of alike (ORR-952)', async () => {
        const pulls = new Pulls(store, async () => { throw new Error('no GitHub here') })
        const poll = new PullPoll(store, pulls, async () => false, () => {}, () => {})
        const repo = (p: string) => `ada/${p}-polled`
        const row = (p: string, number: number, extra: Partial<PolledRow> = {}): PolledRow => ({number, names: [`KEY-${number}`], title: `Pull ${number}`, url: `https://github.com/${repo(p)}/pull/${number}`,
            branch: `feat/pull-${number}`, base: 'v1.0.0-rc.18', author: 'ada', draft: false, head_sha: `sha${number}`, state: 'clean', review: null, review_id: null, checks: 'success',
            merged: false, closed: false, merge_sha: null, closed_by: null, created_at: '2026-11-05T10:00:00Z', updated_at: '2026-11-05T10:00:00Z', told: [], ...extra})
        const step = (name: string, ts: (p: string) => Promise<unknown>, path: string, body: (p: string) => unknown, method = 'PUT') => both(name,
            p => viaStore(() => ts(p)), () => viaApi(method, path.replace('<repo>', repo('through-api')), body('through-api')))
        const kept = () => both('what\'s kept', p => viaStore(async () => ({
            pulls: await store.db.all('SELECT number, names, title, url, branch, base, author, draft, head_sha, state, review, review_id, checks, merged, closed, merge_sha, closed_by, created_at, updated_at, seen_at, told FROM pull_states WHERE repo = ? ORDER BY number', repo(p)),
            repo: await store.db.all('SELECT polled_at, token, error, history_page FROM pull_repos WHERE repo = ?', repo(p)),
            issues: await store.db.all('SELECT number, state, updated_at FROM issue_pulls WHERE repo = ? ORDER BY number', repo(p)),
        })), () => viaStore(async () => ({
            pulls: await store.db.all('SELECT number, names, title, url, branch, base, author, draft, head_sha, state, review, review_id, checks, merged, closed, merge_sha, closed_by, created_at, updated_at, seen_at, told FROM pull_states WHERE repo = ? ORDER BY number', repo('through-api')),
            repo: await store.db.all('SELECT polled_at, token, error, history_page FROM pull_repos WHERE repo = ?', repo('through-api')),
            issues: await store.db.all('SELECT number, state, updated_at FROM issue_pulls WHERE repo = ? ORDER BY number', repo('through-api')),
        })))
        const first = (p: string) => ({at: '2026-11-05T10:01:00Z', token: true, more: false, pulls: [row(p, 1), row(p, 2, {draft: true, review: 'approved', review_id: 'r9'}), row(p, 3, {merged: true, merge_sha: 'm3', state: 'merged'})]})
        const outcomes = [
            await step('a first poll', p => poll.keepPolled(repo(p), first(p)), '/api/pulls/<repo>', first),
            await step('history to read', p => poll.keepHistory(repo(p), 3), '/api/pulls/<repo>/history', () => ({page: 3})),
        ]
        for (const p of ['through-store', 'through-api']) {
            const issue = (await store.createIssue('through-api' === p ? 'through-api' : 'through-store', {title: `On pull 2 of ${p}`}, OWNER)).id
            await store.db.run(`INSERT INTO issue_pulls (project, issue, repo, number, title, url, branch, base, author, state, merged_at, created_at, updated_at) VALUES (?, ?, ?, 2, 'Pull 2', 'u', 'b', 'v', 'ada', 'open', NULL, ?, ?)`,
                p, issue, repo(p), '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z')
        }
        const second = (p: string) => ({at: '2026-11-05T10:02:00Z', token: false, more: false, pulls: [row(p, 1, {told: [`${repo(p)}#1 checks_failed sha1`], checks: 'failure', updated_at: '2026-11-05T10:02:00Z'})]})
        const cut = () => ({at: '2026-11-05T10:03:00Z', token: true, more: true, pulls: []})
        outcomes.push(
            await step('a poll that missed #2, so it\'s closed', p => poll.keepPolled(repo(p), second(p)), '/api/pulls/<repo>', second),
            await kept(),
            await step('one cut short closes nothing', p => poll.keepPolled(repo(p), cut(p)), '/api/pulls/<repo>', cut),
            await step('a failure', p => poll.keepFailed(repo(p), 'GitHub said no'), '/api/pulls/<repo>/error', () => ({error: 'GitHub said no'})),
            await kept(),
        )
        // Letting go works across every repo, so each side has a repo of its own to lose.
        const all = async () => (await store.db.all<{repo: string}>('SELECT repo FROM pull_repos')).map(r => r.repo)
        for (const p of ['through-store', 'through-api']) {
            const gone = `ada/${p}-gone`
            await poll.keepPolled(gone, {at: '2026-11-05T10:00:00Z', token: true, more: false, pulls: []})
            const keep = (await all()).filter(r => r !== gone)
            outcomes.push(p === 'through-store'
                ? await viaStore(async () => ({gone: await poll.keepForgotten(keep, '2026-11-05T10:01:30Z')}))
                : await viaApi('POST', '/api/pulls/forget', {repos: keep, before: '2026-11-05T10:01:30Z'}))
        }
        expect(same(outcomes.at(-1)!, 'through-api')).toEqual(same(outcomes.at(-2)!, 'through-store'))
        outcomes.push(await kept())
        expect(outcomes[0]).toMatchObject({status: 204, changed: [], told: []})
        expect((outcomes[3]!.body as {pulls: {number: number, closed: number}[], issues: {state: string}[]}).pulls.find(p => p.number === 2)).toMatchObject({closed: 1})
        expect((outcomes[3]!.body as {issues: {state: string}[]}).issues).toEqual([expect.objectContaining({state: 'closed'})])
        expect((outcomes[6]!.body as {repo: {error: string, history_page: number}[]}).repo).toEqual([expect.objectContaining({error: 'GitHub said no', history_page: 3})])
        expect(outcomes.at(-2)!.body).toEqual({gone: ['ada/through-api-gone']})
        // The merged #3, last seen before the cut-off, is let go of.
        expect((outcomes.at(-1)!.body as {pulls: {number: number}[]}).pulls.map(p => p.number)).toEqual([1, 2])
        for (const [path, body] of [['/api/pulls/<repo>', {at: 1, pulls: [{number: -1}]}], ['/api/pulls/<repo>/error', {}], ['/api/pulls/<repo>/history', {page: 'next'}], ['/api/pulls/forget', {repos: 'all'}]] as const) {
            expect((await viaApi(path === '/api/pulls/forget' ? 'POST' : 'PUT', path.replace('<repo>', repo('through-api')), body)).status, path).toBe(400)
        }
    })

    it('reads the chats as they\'re kept alike, running and ended (ORR-951)', async () => {
        const kept = (id: string, project: string, started: string, extra: Record<string, unknown> = {}) => ({id, project: 'not this', started_at: started, issues: 'todo',
            messages: [{id: 1, from: 'owner', text: `Hello from ${id}`, images: [], at: started}, {id: 2, from: 'claude', text: 'Hi.', images: [], at: started}], ...extra})
        const rows = [
            kept('c0ffee000001', 'through-store', '2026-11-05T10:00:00.000Z'),
            kept('c0ffee000002', 'through-api', '2026-11-05T12:00:00.000Z', {ended: true, ended_at: '2026-11-05T12:30:00.000Z', claude_session: 's-1', ran_on: {model: 'opus'}}),
            kept('c0ffee000003', 'through-api', '2026-11-05T11:00:00.000Z', {issues: 'backlog'}),
        ]
        for (const [chat, project] of rows.map((c, i) => [c, ['through-store', 'through-api', 'through-api'][i]!] as const)) {
            await store.db.run('INSERT INTO chats (id, project, started_at, ended_at, chat) VALUES (?, ?, ?, ?, ?)', chat.id, project, chat.started_at, (chat as {ended_at?: string}).ended_at ?? null, JSON.stringify(chat))
        }
        // The store's side is the chats module reading them back as orrery starts, with Nitro's globals stubbed.
        vi.stubGlobal('useDatabase', () => store.db)
        vi.stubGlobal('notFound', (await import('../server/utils/input')).notFound)
        vi.resetModules()
        const chats = await import('../server/utils/chats')
        await chats.chatsLoaded()
        const listed = await viaApi('GET', '/api/chats')
        expect(listed.status).toBe(200)
        expect(listed.body).toEqual(JSON.parse(JSON.stringify(chats.listChats())))
        expect((listed.body as {id: string, project: string}[]).map(c => `${c.id} ${c.project}`)).toEqual(['c0ffee000002 through-api', 'c0ffee000003 through-api', 'c0ffee000001 through-store'])
        for (const id of ['c0ffee000001', 'c0ffee000002']) expect((await viaApi('GET', `/api/chats/${id}`)).body, id).toEqual(JSON.parse(JSON.stringify(chats.readChat(id))))
        let missing: unknown
        try { chats.readChat('nope') } catch (error) { missing = (error as Error).message }
        expect(await viaApi('GET', '/api/chats/nope')).toMatchObject({status: 404, body: {message: missing}})
        // Keeping one, as the module does as it changes: through the store, and through the API, alike.
        const row = (id: string) => store.db.get<{project: string, started_at: string, ended_at: string | null, chat: string}>('SELECT project, started_at, ended_at, chat FROM chats WHERE id = ?', id)
        const said = (id: string, project: string) => ({...kept(id, project, '2026-11-05T13:00:00.000Z'), project, problem: 'A launcher too old', ended: true, ended_at: '2026-11-05T13:10:00.000Z',
            messages: [{id: 9, from: 'owner', text: 'Ünïcode, "quotes" and a\nline', images: ['up1'], at: '2026-11-05T13:00:00.000Z'}]})
        await chats.keepChat(store.db, said('c0ffee000010', 'through-store') as never)
        expect(await viaApi('PUT', '/api/chats/c0ffee000011', said('c0ffee000011', 'through-api'))).toMatchObject({status: 204, changed: [], told: []})
        const [byStore, byApi] = [await row('c0ffee000010'), await row('c0ffee000011')]
        expect(byApi!.chat).toBe(byStore!.chat.replace('c0ffee000010', 'c0ffee000011').replace('"project":"through-store"', '"project":"through-api"'))
        expect(JSON.parse(byApi!.chat)).not.toHaveProperty('problem')
        expect({...byApi, chat: undefined}).toEqual({...byStore, chat: undefined, project: 'through-api'})
        // Changed again: its project and start stay as first kept.
        await chats.keepChat(store.db, {...said('c0ffee000010', 'through-api'), started_at: '2027-01-01T00:00:00.000Z'} as never)
        await viaApi('PUT', '/api/chats/c0ffee000011', {...said('c0ffee000011', 'through-store'), started_at: '2027-01-01T00:00:00.000Z'})
        expect([(await row('c0ffee000010'))!.project, (await row('c0ffee000011'))!.project]).toEqual(['through-store', 'through-api'])
        expect((await row('c0ffee000011'))!.started_at).toBe('2026-11-05T13:00:00.000Z')
        expect(await viaApi('PUT', '/api/chats/c0ffee000011', {id: 'another', project: 1})).toMatchObject({status: 400})
        await chats.keepChat(store.db, said('c0ffee000010', 'through-store') as never, true)
        expect(await viaApi('DELETE', '/api/chats/c0ffee000011')).toMatchObject({status: 204})
        expect([await row('c0ffee000010'), await row('c0ffee000011')]).toEqual([undefined, undefined])
        vi.unstubAllGlobals()
        expect(domainOf('GET', '/api/chats')).toBeUndefined()
        expect(domainOf('PUT', '/api/chats/c0ffee000011')).toBeUndefined()
    })

    it('lists people, and makes, lists and revokes keys and ends logins alike (ORR-928)', async () => {
        await store.nameOwner({name: 'Steffen'})
        await store.addPerson({name: 'Ada'})
        await store.addPerson({name: 'Bob'})
        // Naming the owner changed every project, so the first step mustn't hear that.
        await quiet()
        const ada = whoHeaders({person: 'ada', owner: false, via: 'browser'}, undefined)
        const owner = whoHeaders({person: 'steffen', owner: true, via: 'browser'}, undefined)
        /** A key's secret and id, and a login's listed id, are bound to differ between the two sides. */
        const shape = (outcome: Outcome): Outcome => JSON.parse(JSON.stringify(outcome, (_key, value: unknown) => typeof value === 'string'
            ? value.replace(/^orrery_(agent|person)_[\w-]{43}$/, 'orrery_$1_<secret>').replace(/^[0-9a-f]{12}$/, '<key id>').replace(/^[0-9a-f]{16}$/, '<login id>')
            : value)) as Outcome
        const alike = async (name: string, ts: () => Promise<Outcome>, rs: () => Promise<Outcome>) => {
            const [a, b] = [await ts(), await rs()]
            expect(same(shape(b), 'through-api'), name).toEqual(same(shape(a), 'through-store'))
            return b
        }
        await alike('the people', () => viaStore(() => store.people()), () => viaApi('GET', '/api/people'))
        const made = await alike('a key, its own', () => viaStore(() => store.makeKey('ada', {kind: 'agent', name: ' laptop '}), 201), () => viaApi('POST', '/api/keys', {kind: 'agent', name: ' laptop '}, AGENT, '', ada))
        expect(made.body).toMatchObject({person: 'ada', kind: 'agent', name: 'laptop', key: expect.stringMatching(/^orrery_agent_/)})
        await alike('a person key the owner gives', () => viaStore(() => store.makeKey('bob', {kind: 'person', name: 'phone'}), 201), () => viaApi('POST', '/api/keys', {kind: 'person', name: 'phone', person: 'bob'}, AGENT, '', owner))
        await alike('a kind there isn\'t', () => viaStore(() => store.makeKey('ada', {kind: 'robot', name: 'x'})), () => viaApi('POST', '/api/keys', {kind: 'robot', name: 'x'}, AGENT, '', ada))
        await alike('no name', () => viaStore(() => store.makeKey('ada', {kind: 'agent', name: '   '})), () => viaApi('POST', '/api/keys', {kind: 'agent', name: '   '}, AGENT, '', ada))
        await alike('for nobody here', () => viaStore(() => store.makeKey('nobody', {kind: 'agent', name: 'x'})), () => viaApi('POST', '/api/keys', {kind: 'agent', name: 'x', person: 'nobody'}, AGENT, '', owner))
        await alike('ada\'s keys', () => viaStore(() => store.keys('ada')), () => viaApi('GET', '/api/keys', undefined, AGENT, '', ada))
        await alike('everyone\'s, for the owner by name with auth off', () => viaStore(() => store.keys()), () => viaApi('GET', '/api/keys', undefined, OWNER))
        // The key the API made works as a credential.
        expect(await store.keyHolder((made.body as {key: string}).key)).toMatchObject({person: 'ada', kind: 'agent'})
        // Logins: two of ada's, one started with a key, and one of bob's.
        const [byKey, other] = await store.keys('ada')
        const mine = (await store.startLogin('ada', byKey!.id, 'Mac')).secret
        await store.startLogin('ada', undefined, 'Phone')
        await store.startLogin('bob')
        await alike('ada\'s logins, hers marked', () => viaStore(() => store.logins('ada', mine)), () => viaApi('GET', '/api/logins', undefined, AGENT, '', {...ada, ...whoHeaders(undefined, mine)}))
        await alike('everyone\'s', () => viaStore(() => store.logins()), () => viaApi('GET', '/api/logins', undefined, OWNER))
        const bobs = (await store.logins('bob'))[0]!.id
        expect((await viaApi('DELETE', `/api/logins/${bobs}`, undefined, AGENT, '', ada)).status).toBe(404)
        expect((await viaApi('DELETE', '/api/logins/not-a-ref', undefined, OWNER)).body).toEqual({message: 'No login "not-a-ref"'})
        expect((await viaApi('DELETE', `/api/logins/${bobs}`, undefined, AGENT, '', owner)).status).toBe(204)
        expect(await store.logins('bob')).toEqual([])
        expect((await viaApi('DELETE', '/api/logins', undefined, AGENT, '', {...ada, ...whoHeaders(undefined, mine)})).body).toEqual({ended: 1})
        expect((await store.logins('ada')).map(l => l.name)).toEqual(['Mac'])
        // Revoking a key ends the logins it started, and nobody else's key is yours to revoke.
        expect((await viaApi('DELETE', `/api/keys/${other!.id}`, undefined, AGENT, '', whoHeaders({person: 'bob', owner: false, via: 'browser'}, undefined))).status).toBe(404)
        expect((await viaApi('DELETE', `/api/keys/${byKey!.id}`, undefined, AGENT, '', ada)).status).toBe(204)
        expect((await viaApi('DELETE', `/api/keys/${byKey!.id}`, undefined, AGENT, '', ada)).status).toBe(204)
        expect(await store.logins('ada')).toEqual([])
        expect((await store.keys('ada')).find(k => k.id === byKey!.id)?.revoked_at).toBeDefined()
        // Only a person handles keys and logins, never a session, whatever key it has: in the table's words.
        const session = (id: string) => ({message: refused(permission(id), 'session').message, data: {permission: id}})
        const agent = whoHeaders({person: 'steffen', owner: true, via: 'agent'}, undefined)
        for (const [method, path] of [['GET', '/api/keys'], ['POST', '/api/keys'], ['DELETE', '/api/keys/x']] as const) {
            const body = method === 'POST' ? {kind: 'agent', name: 'x'} : undefined
            expect((await viaApi(method, path, body, SESSION)).body, `${method} ${path}`).toEqual(session('keys.write'))
            expect((await viaApi(method, path, body, OWNER, '', agent)).body, `${method} ${path} with an agent key`).toEqual(session('keys.write'))
        }
        for (const [method, path] of [['GET', '/api/logins'], ['DELETE', '/api/logins'], ['DELETE', '/api/logins/x']] as const) {
            expect((await viaApi(method, path, undefined, SESSION)).body, `${method} ${path}`).toEqual(session('logins.write'))
            expect((await viaApi(method, path, undefined, OWNER, '', agent)).body, `${method} ${path} with an agent key`).toEqual(session('logins.write'))
        }
        expect(await viaApi('POST', '/api/keys', {kind: 'agent', name: 'x', person: 'bob'}, AGENT, '', ada)).toMatchObject({status: 403, body: {message: 'A person makes their own keys; only the owner gives them to others'}})
    })

    it('logs in by a person key and out alike, with a login the store knows (ORR-928)', async () => {
        await store.addPerson({name: 'Lin'})
        const person = await store.makeKey('lin', {kind: 'person', name: 'laptop'})
        const agent = await store.makeKey('lin', {kind: 'agent', name: 'laptop'})
        const port = new URL(url).port
        const call = (path: string, body?: unknown, extra: Record<string, string> = {}) => fetch(`${url}${path}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...extra},
            ...body === undefined ? {} : {body: JSON.stringify(body)},
        })
        const refused = {message: "That isn't a person key on this orrery, or it's been revoked"}
        for (const [name, body] of [['an agent key', {key: agent.key}], ['no key', {}], ['not a string', {key: 7}], ['one that isn\'t', {key: 'orrery_person_nope'}]] as const) {
            const response = await call('/api/auth/login', body)
            expect(response.status, name).toBe(401)
            expect(await response.json(), name).toEqual({statusCode: 401, statusMessage: "Unauthorized", ...refused})
            expect(response.headers.get('set-cookie'), name).toBeNull()
        }
        // A key with space around it still signs in, as the route here trims it.
        const response = await call('/api/auth/login', {key: ` ${person.key} `})
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({person: 'lin'})
        const cookie = response.headers.get('set-cookie')!
        expect(cookie).toMatch(new RegExp(`^orrery_login_${port}=[\\w-]{43}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax$`))
        const secret = /=([^;]+)/.exec(cookie)![1]!
        // The store takes the API's login as its own: named for the key, listed, and ended when the key is revoked.
        expect(await store.loginHolder(secret)).toEqual({person: 'lin', owner: false})
        expect((await store.logins('lin', secret))).toMatchObject([{person: 'lin', current: true}])
        expect((await call('/api/auth/login', {key: person.key}, {'X-Forwarded-Proto': 'https'})).headers.get('set-cookie')).toMatch(/; HttpOnly; Secure; SameSite=Lax$/)
        // Logging out ends it on the server and clears the cookie; with no cookie it only clears it.
        const out = await call('/api/auth/logout', undefined, {Cookie: `other=1; orrery_login_${port}=${secret}`})
        expect(out.status).toBe(204)
        expect(out.headers.get('set-cookie')).toBe(`orrery_login_${port}=; Max-Age=0; Path=/`)
        expect(await store.loginHolder(secret)).toBeUndefined()
        expect((await call('/api/auth/logout')).status).toBe(204)
        await store.revokeKey(person.id)
        expect(await store.logins('lin')).toEqual([])
        expect((await call('/api/auth/login', {key: person.key})).status).toBe(401)
        // Neither is the router's to send yet: the Nuxt server logs in for itself until the swap.
        for (const path of ['/api/auth/login', '/api/auth/logout']) expect(servedByApi('POST', path), path).toBe(false)
    })

    it('says the login status, and makes and takes a phone\'s sign-in link, as the Nuxt server does (ORR-928)', async () => {
        const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => fetch(`${url}${path}`, {
            method,
            headers: {'Content-Type': 'application/json', 'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...extra},
            ...body === undefined ? {} : {body: JSON.stringify(body)},
        })
        const status = async (came: Parameters<typeof cameHeaders>[0], host = 'localhost:9000', ways: {provider: boolean, off: boolean, on?: boolean} = {provider: false, off: false}, extra: Record<string, string> = {}) =>
            (await call('GET', '/api/auth/status', undefined, {...cameHeaders(came, host), ...loginHeaders(ways, 'http://x'), ...extra})).json() as Promise<Record<string, unknown>>
        if (!(await store.ownerOf()).named) await store.nameOwner({name: 'Steffen'})
        const none = {loopback: false, proxied: false, phone: false, https: false}
        const loopback = {...none, loopback: true}
        const stays = await store.authStaysOn()
        const canGetIn = await store.ownerHasKey()
        // On loopback it's off unless auth stays on; anywhere else, through a proxy or on the phone's port it asks.
        expect(await status(loopback)).toEqual({mode: stays ? 'on' : 'off', can_get_in: canGetIn, oidc: false, warn_http: false, phone: false})
        expect((await status(none, '192.168.1.9:9000')).mode).toBe('on')
        expect((await status(none, '192.168.1.9:9000')).warn_http).toBe(true)
        expect((await status({...none, https: true}, 'orrery.example')).warn_http).toBe(false)
        expect((await status({...loopback, proxied: true})).mode).toBe('on')
        expect((await status(loopback, 'localhost:9000', {provider: false, off: false, on: true})).mode).toBe('on')
        expect(await status({...loopback, phone: true})).toMatchObject({mode: 'on', phone: true})
        // ORRERY_AUTH=off lets only loopback in, and the phone's port never.
        expect((await status(loopback, 'localhost:9000', {provider: false, off: true})).mode).toBe('off')
        expect((await status(none, '192.168.1.9:9000', {provider: false, off: true})).mode).toBe('closed')
        expect((await status({...none, phone: true}, '192.168.1.9:9000', {provider: false, off: true})).mode).toBe('closed')
        expect(await status(loopback, 'localhost:9000', {provider: true, off: false})).toMatchObject({oidc: true, can_get_in: true})
        expect(await status(none, '192.168.1.9:9000', undefined, whoHeaders({person: 'ada', owner: false, via: 'browser'}, undefined))).toMatchObject({person: 'ada', via: 'browser'})

        // Making a link: only the owner's own page, never over the phone's port or from a session.
        const owner = await store.ownerOf()
        const asOwner = {...actorHeaders(OWNER), ...whoHeaders({person: owner.name, owner: true, via: 'browser'}, undefined), ...cameHeaders(none, '192.168.1.9:9000')}
        expect((await call('POST', '/api/phone/link', undefined, {...asOwner, ...cameHeaders({...none, phone: true}, 'x')})).status).toBe(403)
        expect((await call('POST', '/api/phone/link', undefined, {...actorHeaders(OWNER), ...whoHeaders({person: 'ada', owner: false, via: 'browser'}, undefined)})).status).toBe(403)
        expect((await call('POST', '/api/phone/link', undefined, {...actorHeaders(OWNER), ...whoHeaders({person: owner.name, owner: true, via: 'agent'}, undefined)})).status).toBe(403)
        const fromSession = await call('POST', '/api/phone/link', undefined, {...actorHeaders(SESSION), ...whoHeaders({person: owner.name, owner: true, via: 'browser'}, undefined)})
        expect(fromSession.status).toBe(403)
        expect(await fromSession.json()).toMatchObject({data: {permission: 'phone.link'}})
        const made = await call('POST', '/api/phone/link', undefined, asOwner)
        expect(made.status).toBe(201)
        const link = await made.json() as {token: string, code: string, expires_at: string}
        expect(link.token).toMatch(/^[\w-]{32}$/)
        expect(link.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/)
        expect(Date.parse(link.expires_at) - Date.now()).toBeGreaterThan(4 * 60_000)

        // Taking it: once, by the link or its code, with a login named as the phone's that the store knows.
        const taken = await call('POST', '/api/auth/link', {token: link.token}, cameHeaders({...none, phone: true, https: true}, 'x'))
        expect(taken.status).toBe(201)
        expect(await taken.json()).toEqual({person: owner.name})
        const cookie = taken.headers.get('set-cookie')!
        expect(cookie).toMatch(/; HttpOnly; Secure; SameSite=Lax$/)
        const secret = /=([^;]+)/.exec(cookie)![1]!
        expect(await store.loginHolder(secret)).toEqual({person: owner.name, owner: true})
        expect(await store.logins(owner.name, secret)).toContainEqual(expect.objectContaining({current: true, name: PHONE_LOGIN}))
        const again = await call('POST', '/api/auth/link', {token: link.token})
        expect(again.status).toBe(401)
        expect(await again.json()).toMatchObject({message: 'This sign-in link has been used or has run out: show the QR code in App settings again'})
        expect((await call('POST', '/api/auth/link', {code: link.code})).status).toBe(401)
        const second = await (await call('POST', '/api/phone/link', undefined, asOwner)).json() as {token: string, code: string}
        const typed = await call('POST', '/api/auth/link', {code: `${second.code.slice(0, 3).toLowerCase()} ${second.code.slice(3)}`})
        expect(typed.status).toBe(201)
        expect((await call('POST', '/api/auth/link', {token: second.token})).status).toBe(401)
        // None of the three is the router's to send yet: the Nuxt server keeps them until the swap.
        for (const [method, path] of [['GET', '/api/auth/status'], ['POST', '/api/auth/link'], ['POST', '/api/phone/link']] as const) expect(servedByApi(method, path), path).toBe(false)
    })

    it('logs in through a provider as the Nuxt server does, with an invite the store made (ORR-928)', async () => {
        // A provider on this machine signing real tokens with keys of its own (as oidc.test.ts has one), and an API
        // pointed at it, on the same database. `sign` says what the next token is; by default the one that's right.
        const {exportJWK, generateKeyPair, SignJWT} = await import('jose')
        const {createServer} = await import('node:http')
        const [ours, theirs] = [await generateKeyPair('RS256'), await generateKeyPair('RS256')]
        const jwk = {...await exportJWK(ours.publicKey), kid: 'one', alg: 'RS256', use: 'sig'}
        let sign: {claims?: Record<string, string>, key?: CryptoKey, none?: boolean} = {}
        let nonce = ''
        const posts: URLSearchParams[] = []
        const provider = createServer(async (req, res) => {
            const json = (body: unknown) => res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(body))
            if (req.url === '/.well-known/openid-configuration') return json({issuer: issuer, authorization_endpoint: `${issuer}/authorize?prompt=login`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`})
            if (req.url === '/jwks') return json({keys: [jwk]})
            let body = ''
            for await (const chunk of req) body += chunk
            posts.push(new URLSearchParams(body))
            if (sign.none) return json({access_token: 'only-this'})
            const claims = {iss: issuer, aud: 'orrery-client', sub: 'account-1', nonce, ...sign.claims}
            const token = new SignJWT({nonce: claims.nonce}).setProtectedHeader({alg: 'RS256', kid: 'one'}).setIssuedAt().setExpirationTime('5m').setIssuer(claims.iss).setAudience(claims.aud)
            if (claims.sub) token.setSubject(claims.sub)
            json({id_token: await token.sign(sign.key ?? ours.privateKey)})
        })
        await new Promise<void>(done => provider.listen(0, '127.0.0.1', done))
        const issuer = `http://127.0.0.1:${(provider.address() as import('node:net').AddressInfo).port}`
        const env = {NUXT_OIDC_ISSUER: `${issuer}/`, NUXT_OIDC_CLIENT_ID: 'orrery-client', NUXT_OIDC_CLIENT_SECRET: 'client-secret', NUXT_ALLOWED_ORIGINS: 'https://app.example'}
        const withProvider = spawn(BIN, [], {env: {...process.env, NUXT_API_TOKEN: TOKEN, NUXT_DATABASE: setting, ORRERY_API_LISTEN: '127.0.0.1:0', ...env, ...POSTGRES ? {ORRERY_API_SCHEMA: schema} : {}}})
        try {
            const at = await new Promise<string>((done, fail) => {
                let said = ''
                withProvider.stderr!.on('data', (chunk: Buffer) => {
                    said += chunk
                    const found = /serving docs on (http:\/\/\S+),/.exec(said)
                    if (found) done(found[1]!)
                })
                withProvider.on('exit', code => fail(new Error(`the API stopped (${code}): ${said}`)))
            })
            const port = new URL(at).port
            const get = (base: string, path: string, cookie?: string) => fetch(`${base}${path}`, {
                redirect: 'manual',
                headers: {'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...cookie ? {Cookie: cookie} : {}},
            })
            const kept = (response: Response) => /^orrery_oidc=([\w-]+);/.exec(response.headers.get('set-cookie') ?? '')?.[1]
            /** A login started here: the provider's page it sends to, and the cookie to come back with. */
            const started = async (query = '') => {
                const response = await get(at, `/api/auth/oidc/start${query}`)
                expect(response.status).toBe(302)
                const to = new URL(response.headers.get('location')!)
                nonce = to.searchParams.get('nonce')!
                return {response, to, cookie: `orrery_oidc=${kept(response)}`}
            }
            const back = (state: string, cookie?: string) => get(at, `/api/auth/oidc/callback?state=${state}&code=the-code`, cookie)
            const failed = async (response: Response, status: number, message: string) => {
                expect(response.status, message).toBe(status)
                expect((await response.json()).message).toBe(message)
                expect(response.headers.get('set-cookie'), message).toBe('orrery_oidc=; Max-Age=0; Path=/api/auth/oidc')
            }

            // Without a provider set up, there's nothing to log in through.
            for (const path of ['/api/auth/oidc/start', '/api/auth/oidc/callback']) {
                const none = await get(url, path)
                expect(none.status, path).toBe(404)
                expect(await none.json(), path).toEqual({statusCode: 404, statusMessage: 'Not Found', message: 'This orrery has no login provider'})
            }

            // Starting sends the browser to the provider, with PKCE, keeping what the way back has to match.
            const {response, to, cookie} = await started('?invite=&back=https://elsewhere.example')
            expect(`${to.origin}${to.pathname}`).toBe(`${issuer}/authorize`)
            expect(Object.fromEntries(to.searchParams)).toEqual({
                response_type: 'code', scope: 'openid', client_id: 'orrery-client', redirect_uri: `http://127.0.0.1:${port}/api/auth/oidc/callback`,
                state: expect.stringMatching(/^[\w-]{43}$/), nonce: expect.stringMatching(/^[\w-]{43}$/), code_challenge: expect.stringMatching(/^[\w-]{43}$/), code_challenge_method: 'S256',
            })
            expect(response.headers.get('set-cookie')).toMatch(/^orrery_oidc=[\w-]+; Max-Age=600; Path=\/api\/auth\/oidc; HttpOnly; SameSite=Lax$/)
            const asked = JSON.parse(Buffer.from(kept(response)!, 'base64url').toString())
            // An empty invite and an origin that isn't listed are left out.
            expect(asked).toEqual({state: to.searchParams.get('state'), nonce, verifier: expect.any(String)})
            const proxied = await fetch(`${at}/api/auth/oidc/start`, {redirect: 'manual', headers: {'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'orrery.example'}})
            expect(new URL(proxied.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://orrery.example/api/auth/oidc/callback')
            expect(proxied.headers.get('set-cookie')).toMatch(/; HttpOnly; Secure; SameSite=Lax$/)

            // An account nobody here has, and no invite: refused, and the kept cookie is cleared either way.
            await failed(await back(to.searchParams.get('state')!, cookie), 403, "This account isn't on this orrery: ask its owner for an invite")
            // The code is swapped with the verifier whose challenge was sent.
            const swap = posts.at(-1)!
            expect(Object.fromEntries(swap)).toMatchObject({grant_type: 'authorization_code', code: 'the-code', client_id: 'orrery-client', client_secret: 'client-secret', redirect_uri: `http://127.0.0.1:${port}/api/auth/oidc/callback`})
            expect(createHash('sha256').update(swap.get('code_verifier')!).digest('base64url')).toBe(to.searchParams.get('code_challenge'))

            // A way back this browser didn't start, or with no cookie, or a token that doesn't check out, is refused.
            const second = await started()
            await failed(await back('another-state', second.cookie), 401, "This login doesn't match the one this browser started")
            await failed(await back('x'), 401, 'This login has run out: start again')
            await failed(await back('x', 'orrery_oidc=bm90IGpzb24'), 401, "This login doesn't match the one this browser started")
            for (const [name, token] of [
                ['signed with another key', {key: theirs.privateKey}],
                ['for another client', {claims: {aud: 'someone-else'}}],
                ['from another issuer', {claims: {iss: 'http://127.0.0.1:1'}}],
                ['for another login', {claims: {nonce: 'another'}}],
                ['for nobody', {claims: {sub: ''}}],
            ] as const) {
                const login = await started()
                sign = token
                const refusedToken = await back(login.to.searchParams.get('state')!, login.cookie)
                expect(refusedToken.status, name).toBe(401)
                await failed(refusedToken, 401, "The provider's ID token doesn't check out")
            }
            sign = {none: true}
            const noToken = await started()
            await failed(await back(noToken.to.searchParams.get('state')!, noToken.cookie), 401, 'The provider gave no ID token')
            sign = {}

            // With an invite the store made, the account attaches to its person, who is logged in: a login the store knows.
            await store.addPerson({name: 'Oda'})
            const invite = await store.invite('oda')
            const invited = await started(`?invite=${invite.secret}&back=https://app.example`)
            const home = await back(invited.to.searchParams.get('state')!, invited.cookie)
            expect(home.status).toBe(302)
            expect(home.headers.get('location')).toBe('https://app.example/')
            const cookies = home.headers.getSetCookie()
            expect(cookies[0]).toBe('orrery_oidc=; Max-Age=0; Path=/api/auth/oidc')
            expect(cookies[1]).toMatch(new RegExp(`^orrery_login_${port}=[\\w-]{43}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax$`))
            expect(await store.loginHolder(/=([^;]+)/.exec(cookies[1]!)![1]!)).toEqual({person: 'oda', owner: false})
            // The store finds the same person by the account, as the issuer is kept with no trailing slash either way.
            expect(await store.identity(issuer, 'account-1')).toBe('oda')
            // Used up: the same invite can't attach another account.
            sign = {claims: {sub: 'account-2'}}
            const again = await started(`?invite=${invite.secret}`)
            await failed(await back(again.to.searchParams.get('state')!, again.cookie), 409, 'That invite has been used or has run out: ask for a new one')
            sign = {}
            // The account is known now, so it logs in with no invite, to the board.
            const known = await started()
            const board = await back(known.to.searchParams.get('state')!, known.cookie)
            expect(board.status).toBe(302)
            expect(board.headers.get('location')).toBe('/')
            // An account that belongs to someone here never moves to another invite.
            await store.addPerson({name: 'Per'})
            const other = await store.invite('per')
            await expect(store.identity(issuer, 'account-1', other.secret)).resolves.toBe('oda')
            // Neither is the router's to send yet: the Nuxt server logs in for itself until the swap.
            for (const path of ['/api/auth/oidc/start', '/api/auth/oidc/callback']) expect(servedByApi('GET', path), path).toBe(false)
        } finally {
            withProvider.kill()
            provider.closeAllConnections()
            provider.close()
        }
    })

    it('adds and renames people, and invites them, alike (ORR-928)', async () => {
        // The people are the orrery's, so each step runs on each side in turn, with the table put back between.
        await store.db.run("INSERT INTO people (id, name, role, created_at, removed_at) VALUES ('gone', 'Gone', 'member', ?, ?)", new Date().toISOString(), new Date().toISOString())
        const before = await store.people()
        const putBack = async () => {
            for (const p of before) await store.db.run('UPDATE people SET name = ? WHERE id = ?', p.name, p.id)
            for (const p of await store.people()) if (!before.some(b => b.id === p.id)) await store.db.run('DELETE FROM people WHERE id = ?', p.id)
        }
        const off = loginHeaders({provider: false, off: true}, 'http://localhost:9000')
        const inTurn = async (name: string, ts: () => Promise<Outcome>, rs: () => Promise<Outcome>) => {
            const a = await ts()
            await putBack()
            const b = await rs()
            await putBack()
            expect(same(b, 'through-api'), name).toEqual(same(a, 'through-store'))
            return b
        }
        await inTurn('a member', () => viaStore(() => store.addPerson({name: ' Åse Berg '}), 201), () => viaApi('POST', '/api/people', {name: ' Åse Berg '}, OWNER, '', off))
        await inTurn('a long name', () => viaStore(() => store.addPerson({name: 'C'.repeat(80)}), 201), () => viaApi('POST', '/api/people', {name: 'C'.repeat(80)}, OWNER, '', off))
        await inTurn('one already here', () => viaStore(() => store.addPerson({name: 'ADA'})), () => viaApi('POST', '/api/people', {name: 'ADA'}, OWNER, '', off))
        await inTurn('what agents go by', () => viaStore(() => store.addPerson({name: 'Claude'})), () => viaApi('POST', '/api/people', {name: 'Claude'}, OWNER, '', off))
        await inTurn('no letters', () => viaStore(() => store.addPerson({name: '!!!'})), () => viaApi('POST', '/api/people', {name: '!!!'}, OWNER, '', off))
        await inTurn('several problems', () => viaStore(() => store.addPerson({name: 4, role: 'owner'})), () => viaApi('POST', '/api/people', {name: 4, role: 'owner'}, OWNER, '', off))
        await inTurn('an empty name', () => viaStore(() => store.addPerson({name: '  '})), () => viaApi('POST', '/api/people', {name: '  '}, OWNER, '', off))
        await inTurn('no body', () => viaStore(() => store.addPerson(undefined)), () => viaApi('POST', '/api/people', undefined, OWNER, '', off))
        await inTurn('renamed', () => viaStore(() => store.renamePerson('ada', {name: ' Ada L. '})), () => viaApi('PATCH', '/api/people/ada', {name: ' Ada L. '}, OWNER))
        await inTurn('the owner renamed', () => viaStore(() => store.renamePerson('steffen', {name: 'S'})), () => viaApi('PATCH', '/api/people/steffen', {name: 'S'}, OWNER))
        await inTurn('nobody renamed', () => viaStore(() => store.renamePerson('nobody', {name: 'S'})), () => viaApi('PATCH', '/api/people/nobody', {name: 'S'}, OWNER))
        await inTurn('renamed to nothing', () => viaStore(() => store.renamePerson('ada', {name: null})), () => viaApi('PATCH', '/api/people/ada', {name: null}, OWNER))
        const removed = await viaApi('PATCH', '/api/people/gone', {name: 'Back'}, OWNER)
        expect(removed.body).toEqual((await viaStore(() => store.renamePerson('gone', {name: 'Back'}))).body)
        expect(await inTurn('a removed person\'s id', () => viaStore(() => store.addPerson({name: 'Gone'})), () => viaApi('POST', '/api/people', {name: 'Gone'}, OWNER, '', off))).toMatchObject({status: 409})
        // The owner's alone, and a second person needs a way in first.
        const people = (message: string) => ({message, data: {permission: 'people.write'}})
        const session = people(refused(permission('people.write'), 'session').message)
        expect((await viaApi('POST', '/api/people', {name: 'Eve'}, SESSION, '', off)).body).toEqual(session)
        expect((await viaApi('PATCH', '/api/people/ada', {name: 'Eve'}, SESSION)).body).toEqual(session)
        expect((await viaApi('POST', '/api/invites', {person: 'ada'}, SESSION, '', off)).body).toEqual(session)
        expect((await viaApi('POST', '/api/people', {name: 'Eve'}, OWNER, '', whoHeaders({person: 'ada', owner: false, via: 'browser'}, undefined))).body).toEqual(session)
        expect(await viaApi('POST', '/api/people', {name: 'Eve'}, OWNER)).toMatchObject({status: 409, body: {message: expect.stringMatching(/^A second person turns login on/)}})
        expect(await viaApi('POST', '/api/people', {name: 'Eve'}, OWNER, '', loginHeaders({provider: true, off: false}, ''))).toMatchObject({status: 201, body: {id: 'eve'}})
        const key = await store.makeKey('steffen', {kind: 'person', name: 'Mac'})
        expect(await viaApi('POST', '/api/people', {name: 'Fay'}, OWNER)).toMatchObject({status: 201, body: {id: 'fay'}})
        await store.revokeKey(key.id)
        // Invites: only with a provider, for someone here, with a link at the request's own address that logs them in.
        const provider = loginHeaders({provider: true, off: false}, 'https://orrery.example')
        expect((await viaApi('POST', '/api/invites', {person: 'ada'}, OWNER, '', off)).body).toEqual({message: 'This orrery has no login provider to invite someone through: give them a person key instead (POST /api/keys)'})
        expect((await viaApi('POST', '/api/invites', {}, OWNER, '', provider)).body).toMatchObject({message: '"person" is the id of who to invite'})
        expect((await viaApi('POST', '/api/invites', {person: 'nobody'}, OWNER, '', provider)).body).toEqual((await viaStore(() => store.invite('nobody'))).body)
        const invited = await viaApi('POST', '/api/invites', {person: 'ada'}, OWNER, '', provider)
        expect(invited).toMatchObject({status: 201, body: {url: expect.stringMatching(/^https:\/\/orrery\.example\/login\?invite=[\w-]{43}$/)}})
        const secret = new URL((invited.body as {url: string}).url).searchParams.get('invite')!
        expect(await store.identity('https://id.example', 'sub-1', secret)).toBe('ada')
        await expect(store.identity('https://id.example', 'sub-2', secret)).rejects.toMatchObject({statusCode: 409})
    })

    it('gives a new project to whoever asks alike, as the route here works it out (ORR-1002)', async () => {
        // The store is handed who holds it (`personOf`, by the route); the API works it out from the headers.
        const cases: [string, Actor, string | undefined, Record<string, string>?][] = [
            ['the owner', OWNER, 'steffen'],
            ['a session naming its person', {name: 'agent', owner: false, named: 'Ada', asked: true}, 'ada'],
            ['a session naming nobody', {...AGENT, asked: true}, undefined],
            ['the owner\'s chat', {name: 'steffen', owner: false, chat: true}, 'steffen'],
            ['an untrusted session', {name: 'agent', owner: false, untrusted: true, asked: true}, undefined],
            ['an agent with its person\'s key', {name: 'agent', owner: false, named: 'bob', asked: true}, 'bob', whoHeaders({person: 'bob', owner: false, via: 'agent'}, undefined)],
        ]
        const members = async (project: string) => store.db.all('SELECT person, role FROM project_members WHERE project = ? ORDER BY person', project)
        for (const [i, [name, actor, holder, extra]] of cases.entries()) {
            await store.createProject({name: `Held ${i}`, id: `through-store-held-${i}`}, actor, holder)
            const made = await viaApi('POST', '/api/projects', {name: `Held ${i}`, id: `through-api-held-${i}`}, actor, '', extra)
            expect(made.status, name).toBe(201)
            expect(await members(`through-api-held-${i}`), name).toEqual(await members(`through-store-held-${i}`))
        }
        expect(await members('through-api-held-1')).toEqual([{person: 'ada', role: 'owner'}])
        expect(await members('through-api-held-2')).toEqual([{person: 'steffen', role: 'owner'}])
        expect(await members('through-api-held-5')).toEqual([{person: 'bob', role: 'owner'}])
    })

    it('takes an issue up and lets it go alike, with the rails between people, and tells each (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const ids: Record<string, Record<string, string>> = {}
        const make = async (p: string, title: string, assignee?: string) => (await store.createIssue(p, {title, ...assignee ? {assignee} : {}}, OWNER)).id
        for (const p of ['through-store', 'through-api']) ids[p] = {loose: await make(p, 'Oil the gears'), claude: await make(p, 'Wind the spring', 'claude')}
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const claim = (name: string, which: string, actor: Actor): Step =>
            [name, p => viaStore(() => store.claimIssue(p, ids[p]![which] ?? which, actor)), () => viaApi('POST', `/issues/${ids['through-api']![which] ?? which}/claim`, undefined, actor)]
        const release = (name: string, which: string, actor: Actor): Step =>
            [name, p => viaStore(() => store.releaseIssue(p, ids[p]![which] ?? which, actor)), () => viaApi('DELETE', `/issues/${ids['through-api']![which] ?? which}/claim`, undefined, actor)]
        const activity = (which: string): Step =>
            [`${which}'s activity`, p => viaStore(() => store.listActivity(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}/activity`)]
        // One person here: no rails, so an agent takes up what's nobody's for the owner.
        for (const [name, ts, rs] of [
            claim('nobody\'s, by an agent', 'loose', AGENT),
            claim('the same again', 'loose', AGENT),
            release('let go by the agent', 'loose', AGENT),
            release('let go again', 'loose', AGENT),
            claim('claude\'s, by the owner', 'claude', OWNER),
            release('the owner\'s, by an agent', 'claude', AGENT),
            claim('one that isn\'t there', 'X-404', AGENT),
            release('one that isn\'t there', 'X-404', AGENT),
            activity('loose'),
            activity('claude'),
        ] as Step[]) await both(name, ts, rs)
        // Two people: an agent takes up only its person's, and lets go only of its person's claim.
        if (!(await store.people()).some(person => person.id === 'hal')) await store.addPerson({name: 'Hal'})
        const HALS: Actor = {name: 'agent', owner: false, session: 'orrery · Hal', asked: true, named: 'hal'}
        const HAL: Actor = {name: 'hal', owner: false, person: 'hal', asked: true}
        const NAMELESS: Actor = {name: 'agent', owner: false, session: 'orrery · Zed', asked: true, named: 'zed'}
        for (const p of ['through-store', 'through-api']) {
            ids[p] = {...ids[p], owners: await make(p, 'Polish the brass', 'steffen'), hals: await make(p, 'Count the teeth', 'hal'), open: await make(p, 'Sweep up')}
        }
        for (const [name, ts, rs] of [
            claim('the owner\'s, by Hal\'s agent', 'owners', HALS),
            claim('Hal\'s, by Hal\'s agent', 'hals', HALS),
            release('Hal\'s, let go by a nameless agent', 'hals', NAMELESS),
            claim('Hal\'s, taken over by the owner', 'hals', OWNER),
            release('the owner\'s claim, by Hal\'s agent', 'hals', HALS),
            claim('nobody\'s, by a nameless agent', 'open', NAMELESS),
            claim('nobody\'s, by Hal', 'open', HAL),
            release('Hal\'s, let go by Hal', 'open', HAL),
            activity('hals'),
            activity('open'),
        ] as Step[]) await both(name, ts, rs)
        // Hal gone without a trace, so a later step can hire them afresh.
        await store.db.run("UPDATE issues SET assignee = NULL WHERE assignee = 'hal'")
        await store.db.run("DELETE FROM people WHERE id = 'hal'")
        await quiet()
        // The same rows in the outbox, each claim and new assignee told: the store's own land a step later, so sorted.
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        expect((await rows('through-api')).filter(row => row.startsWith('issue.claim ')).length).toBeGreaterThan(4)
    })

    it('deletes an issue alike, with what was under it, freeing what waited on it, and refuses what isn\'t the agent\'s (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const key = (p: string) => p === 'through-store' ? 'STO' : 'API'
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            const frame = (await store.createIssue(p, {title: 'Build the frame'}, AGENT)).id
            const strut = (await store.createIssue(p, {title: 'Cut a strut', parent: frame}, AGENT)).id
            await store.createComment(p, strut, {body: 'Oak, not pine.'}, AGENT)
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${key(p)}-97`, frame)
            const paint = (await store.createIssue(p, {title: 'Paint the frame', depends_on: [frame, strut]}, AGENT)).id
            const brass = (await store.createIssue(p, {title: 'Polish the brass'}, OWNER)).id
            const loose = (await store.createIssue(p, {title: 'Sweep up'}, AGENT)).id
            await store.createComment(p, loose, {body: 'Mind the corners.'}, OWNER)
            const hals = (await store.createIssue(p, {title: 'Count the teeth', assignee: 'claude'}, AGENT)).id
            ids[p] = {frame, strut, paint, brass, loose, hals}
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        // A comment's id is in a refusal's words, and ids differ between the two projects.
        const masked = async (outcome: Promise<Outcome>) => JSON.parse(JSON.stringify(await outcome).replace(/comment \d+/g, 'comment <n>')) as Outcome
        const drop = (name: string, which: (p: string) => string, actor: Actor): Step =>
            [name, p => masked(viaStore(async () => store.deleteIssue(p, which(p), actor), 204)), () => masked(viaApi('DELETE', `/issues/${which('through-api')}`, undefined, actor))]
        const read = (name: string, which: string): Step =>
            [name, p => viaStore(() => store.issue(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}`)]
        const steps: Step[] = [
            drop('the owner\'s, by an agent', p => ids[p]!.brass!, AGENT),
            drop('one with the owner\'s comment, by an agent', p => ids[p]!.loose!, AGENT),
            drop('by an id it had before, with a sub-issue and a comment', p => `${key(p)}-97`, AGENT),
            drop('gone already', p => ids[p]!.strut!, AGENT),
            drop('one that isn\'t there', () => 'X-404', AGENT),
            read('what waited on it, waiting no more', 'paint'),
            ['what waited on it, its activity', p => viaStore(() => store.listActivity(p, ids[p]!.paint!)), () => viaApi('GET', `/issues/${ids['through-api']!.paint}/activity`)],
            drop('the owner\'s, by the owner', p => ids[p]!.brass!, OWNER),
        ]
        for (const [name, ts, rs] of steps) await both(name, ts, rs)
        // Two people: an agent deletes only its person's.
        await store.addPerson({name: 'Hal'})
        const HALS: Actor = {name: 'agent', owner: false, session: 'orrery · Hal', asked: true, named: 'hal'}
        await both('the owner\'s, by Hal\'s agent', p => viaStore(() => store.deleteIssue(p, ids[p]!.hals!, HALS)), () => viaApi('DELETE', `/issues/${ids['through-api']!.hals}`, undefined, HALS))
        await store.db.run("DELETE FROM people WHERE id = 'hal'")
        await quiet()
        await both('the board after', p => viaStore(async () => (await store.listIssues(p)).map(i => i.title).sort()), async () => {
            const outcome = await viaApi('GET', '/issues')
            return {...outcome, body: (outcome.body as {title: string}[]).map(i => i.title).sort()}
        })
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        expect((await rows('through-api')).filter(row => row.startsWith('issue.deleted ')).length).toBe(2)
        // Made waiting on the frame and its strut, then freed of each.
        expect((await rows('through-api')).filter(row => row.startsWith('issue.depends '))).toHaveLength(3)
    })

    it('changes many issues alike, each on its own, the refused ones saying why (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const before = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM signals'))?.n ?? 0
        const key = (p: string) => p === 'through-store' ? 'STO' : 'API'
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            const saw = (await store.createIssue(p, {title: 'Sharpen the saw', labels: ['old', 'tools']}, AGENT)).id
            const plane = (await store.createIssue(p, {title: 'Plane the boards', labels: ['wood']}, AGENT)).id
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${key(p)}-97`, plane)
            const idea = (await store.createIssue(p, {title: 'A dovetail jig', proposal: 'pending'}, AGENT)).id
            const owners = (await store.createIssue(p, {title: 'Choose the wood'}, OWNER)).id
            ids[p] = {saw, plane, idea, owners}
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const change = (name: string, body: (p: string) => unknown, actor: Actor = AGENT): Step =>
            [name, p => viaStore(() => store.updateIssues(p, body(p), actor)), () => viaApi('PATCH', '/issues', body('through-api'), actor)]
        const steps: Step[] = [
            change('no ids', () => ({set: {priority: 'P2'}})),
            change('an empty list', () => ({ids: [], set: {priority: 'P2'}})),
            change('fields many can\'t take', p => ({ids: [ids[p]!.saw], set: {title: 'Saw', notes: 'Sharp', priority: 'P2'}})),
            change('a "set" that\'s words', p => ({ids: [ids[p]!.saw], set: 'ab'})),
            change('labels to add that aren\'t a list', p => ({ids: [ids[p]!.saw], labels: {add: 'glue'}})),
            change('labels to take off that are null', p => ({ids: [ids[p]!.saw], labels: {remove: null}})),
            change('a status, a priority and labels, by an id it had, sent twice, the owner\'s, a proposal and one that isn\'t there',
                p => ({ids: [ids[p]!.saw, `${key(p)}-97`, ids[p]!.saw, ids[p]!.owners, ids[p]!.idea, 'X-404'], set: {status: 'in-progress', priority: 'P1'}, labels: {add: ['wood', 'shop'], remove: ['old']}})),
            change('a status that isn\'t one', p => ({ids: [ids[p]!.saw], set: {status: 'somewhere'}})),
            change('urgent and the owner\'s, by the owner', p => ({ids: [ids[p]!.owners, ids[p]!.plane], set: {priority: 'P0', assignee: 'owner'}}), OWNER),
            change('only labels, by the owner', p => ({ids: [ids[p]!.owners], labels: {add: ['wood']}}), OWNER),
            ['in a project that isn\'t there', () => viaStore(() => store.updateIssues('nowhere', {ids: ['X-1'], set: {priority: 'P1'}}, AGENT)), () => viaApi('PATCH', '/issues', {ids: ['X-1'], set: {priority: 'P1'}}, AGENT, 'nowhere')],
        ]
        for (const [name, ts, rs] of steps) await both(name, ts, rs)
        await quiet()
        await both('the board after', p => viaStore(async () => (await store.listIssues(p)).map(i => `${i.title} ${i.status} ${i.priority} ${i.assignee} ${i.labels.join(',')}`).sort()), async () => {
            const outcome = await viaApi('GET', '/issues')
            return {...outcome, body: (outcome.body as {title: string, status: string, priority: string, assignee: string, labels: string[]}[]).map(i => `${i.title} ${i.status} ${i.priority} ${i.assignee} ${i.labels.join(',')}`).sort()}
        })
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        // The two the owner made urgent are pushed to the sessions, each once, on both.
        const focus = async (p: string) => (await store.db.all<{issue: string}>(`SELECT issue FROM signals WHERE project = ? AND id > ? AND kind = 'focus' ORDER BY issue`, p, before))
            .map(r => r.issue.replace(/^(STO|API)-/, 'KEY-'))
        expect(await focus('through-api')).toEqual(await focus('through-store'))
        expect(await focus('through-api')).toHaveLength(2)
    })

    it('deletes many issues alike, each on its own, the refused ones saying why (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const key = (p: string) => p === 'through-store' ? 'STO' : 'API'
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            const case_ = (await store.createIssue(p, {title: 'Build the case'}, AGENT)).id
            const hinge = (await store.createIssue(p, {title: 'Fit the hinge', parent: case_}, AGENT)).id
            const lid = (await store.createIssue(p, {title: 'Carve the lid'}, AGENT)).id
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${key(p)}-98`, lid)
            const varnish = (await store.createIssue(p, {title: 'Varnish it', depends_on: [case_]}, AGENT)).id
            const owners = (await store.createIssue(p, {title: 'Choose the wood'}, OWNER)).id
            const last = (await store.createIssue(p, {title: 'Ship it'}, AGENT)).id
            ids[p] = {case: case_, hinge, lid, varnish, owners, last}
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const drop = (name: string, body: (p: string) => unknown, actor: Actor = AGENT): Step =>
            [name, p => viaStore(() => store.deleteIssues(p, body(p), actor)), () => viaApi('DELETE', '/issues', body('through-api'), actor)]
        const steps: Step[] = [
            drop('no ids', () => ({})),
            drop('ids that aren\'t a list of ids', () => ({ids: ['X-1', 2]})),
            drop('an empty list', () => ({ids: []})),
            drop('a parent, its sub-issue after it, one by an id it had before, the owner\'s, one sent twice and one that isn\'t there',
                p => ({ids: [ids[p]!.case, ids[p]!.hinge, `${key(p)}-98`, ids[p]!.owners, ids[p]!.case, 'X-404']})),
            drop('the owner\'s, by the owner', p => ({ids: [ids[p]!.owners]}), OWNER),
            ['what waited on it, its activity', p => viaStore(() => store.listActivity(p, ids[p]!.varnish!)), () => viaApi('GET', `/issues/${ids['through-api']!.varnish}/activity`)],
            ['in a project that isn\'t there', () => viaStore(() => store.deleteIssues('nowhere', {ids: ['X-1']}, AGENT)), () => viaApi('DELETE', '/issues', {ids: ['X-1']}, AGENT, 'nowhere')],
        ]
        for (const [name, ts, rs] of steps) await both(name, ts, rs)
        await quiet()
        await both('the board after', p => viaStore(async () => (await store.listIssues(p)).map(i => i.title).sort()), async () => {
            const outcome = await viaApi('GET', '/issues')
            return {...outcome, body: (outcome.body as {title: string}[]).map(i => i.title).sort()}
        })
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        expect((await rows('through-api')).filter(row => row.startsWith('issue.deleted '))).toHaveLength(3)
    })

    it('changes an issue\'s own words alike, with the rails between people, noting and telling each (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            ids[p] = {gear: (await store.createIssue(p, {title: 'Cut the gear', notes: 'Brass.', labels: ['shop']}, OWNER)).id}
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const edit = (name: string, which: string, body: unknown, actor: Actor = AGENT): Step =>
            [name, p => viaStore(() => store.updateIssue(p, ids[p]![which] ?? which, body, actor)), () => viaApi('PATCH', `/issues/${ids['through-api']![which] ?? which}`, body, actor)]
        const activity = (which: string): Step =>
            [`${which}'s activity`, p => viaStore(() => store.listActivity(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}/activity`)]
        for (const [name, ts, rs] of [
            edit('its title, notes and labels', 'gear', {title: '  Cut the big gear ', notes: 'Brass, not steel.', labels: ['shop', ' shop', 'metal']}),
            edit('the same again', 'gear', {title: 'Cut the big gear', labels: ['shop', 'metal']}),
            edit('its GitHub issues and tasks', 'gear', {github_issues: [12, 'ada/box#12', 'https://github.com/x/y/issues/3'], external: ['ENG-1', ' ENG-1 ', 'ENG-2']}),
            edit('one that isn\'t a GitHub issue', 'gear', {github_issues: ['nope']}),
            edit('its model, effort and place', 'gear', {model: 'sonnet', effort: 'high', position: 3}, OWNER),
            edit('each cleared', 'gear', {notes: null, labels: null, external: null, github_issues: null, model: null, effort: null}),
            edit('several problems', 'gear', {title: '', model: 'gpt', effort: 'huge', position: null, labels: [''], github_issues: [0]}),
            edit('not an object', 'gear', ['title']),
            edit('one that isn\'t there', 'X-404', {title: 'Gone'}),
            activity('gear'),
        ] as Step[]) await both(name, ts, rs)
        // Two people: an agent changes only its person's, or its own proposal.
        await store.addPerson({name: 'Hal'})
        const HALS: Actor = {name: 'agent', owner: false, session: 'orrery · Hal', asked: true, named: 'hal'}
        const NAMELESS: Actor = {name: 'agent', owner: false, session: 'orrery · Zed', asked: true, named: 'zed'}
        for (const p of ['through-store', 'through-api']) {
            ids[p] = {
                ...ids[p],
                hals: (await store.createIssue(p, {title: 'Count the teeth', assignee: 'hal'}, OWNER)).id,
                idea: (await store.createIssue(p, {title: 'A bigger gear?', proposal: 'pending'}, HALS)).id,
            }
        }
        for (const [name, ts, rs] of [
            edit('the owner\'s, by Hal\'s agent', 'gear', {title: 'Mine now'}, HALS),
            edit('Hal\'s, by Hal\'s agent', 'hals', {notes: 'Forty of them.'}, HALS),
            edit('its own proposal, by Hal\'s agent', 'idea', {title: 'A bigger gear, in brass?'}, HALS),
            edit('Hal\'s, by a nameless agent', 'hals', {title: 'Mine'}, NAMELESS),
            activity('hals'),
            activity('idea'),
        ] as Step[]) await both(name, ts, rs)
        await store.db.run("UPDATE issues SET assignee = NULL WHERE assignee = 'hal'")
        await store.db.run("DELETE FROM people WHERE id = 'hal'")
        await quiet()
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        expect((await rows('through-api')).filter(row => row.startsWith('issue.title ')).length).toBeGreaterThan(1)
    })

    it('changes an issue\'s priority alike, and pushes one made urgent to the sessions as the store does (ORR-927)', async () => {
        const before = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM signals'))?.n ?? 0
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            const make = async (title: string, more: Record<string, unknown> = {}) => (await store.createIssue(p, {title, ...more}, OWNER)).id
            ids[p] = {spring: await make('Wind the spring'), done: await make('Oil it', {status: 'done'}), idea: await make('A bigger spring?', {proposal: 'pending'}), hot: await make('Fix the hand', {priority: 'P0'})}
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const edit = (name: string, which: string, body: unknown, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.updateIssue(p, ids[p]![which]!, body, actor)), () => viaApi('PATCH', `/issues/${ids['through-api']![which]}`, body, actor)]
        const signals = async (p: string) => (await store.db.all<{issue: string, kind: string, note: string | null}>('SELECT issue, kind, note FROM signals WHERE project = ? AND id > ? ORDER BY id', p, before))
            .map(r => `${r.kind} ${r.issue.replace(/^(STO|API)-/, 'KEY-')} ${r.note ?? ''}`)
        for (const [name, ts, rs] of [
            edit('made P1', 'spring', {priority: 'P1'}),
            edit('made P0 by the owner', 'spring', {priority: 'P0'}),
            edit('P0 again', 'spring', {priority: 'P0', title: 'Wind the spring tight'}),
            edit('a done one made P0', 'done', {priority: 'P0'}),
            edit('a proposal made P0', 'idea', {priority: 'P0'}),
            edit('one P0 already, cleared', 'hot', {priority: null}),
            edit('made P0 by an agent', 'hot', {priority: 'P0'}, AGENT),
            edit('not a priority', 'spring', {priority: 'P9'}),
            [`spring's activity`, p => viaStore(() => store.listActivity(p, ids[p]!.spring!)), () => viaApi('GET', `/issues/${ids['through-api']!.spring}/activity`)],
        ] as Step[]) await both(name, ts, rs)
        await quiet()
        expect(await signals('through-api')).toEqual(await signals('through-store'))
        // Made a P0 when it was made, and the spring made one by the owner: none for the rest.
        expect((await signals('through-api')).filter(s => s.startsWith('focus '))).toHaveLength(2)
    })

    it('moves an issue under a parent, into a milestone and a release alike, refusing what the store refuses (ORR-927)', async () => {
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            await store.updateProject(p, {release_mode: 'own'}, OWNER)
            if (!(await store.listReleases(p)).some(r => r.version === '3.0.0')) await store.createRelease(p, {version: '3.0.0'}, OWNER)
            const {id: shelf} = await store.createMilestone(p, {title: 'The shelf'}, OWNER)
            const {id: rack} = await store.createMilestone(p, {title: 'The rack'}, OWNER)
            const make = async (title: string, more: Record<string, unknown> = {}) => (await store.createIssue(p, {title, ...more}, OWNER)).id
            const top = await make('Build the shelf', {milestone: shelf})
            const mid = await make('Cut the boards', {parent: top})
            ids[p] = {shelf, rack, top, mid, low: await make('Mark the cuts', {parent: mid}), loose: await make('Find the saw'), idea: await make('A floating shelf?', {proposal: 'pending'})}
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const id = (p: string, which: string) => ids[p]![which] ?? which
        const edit = (name: string, which: string, body: (p: string) => Record<string, unknown>, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.updateIssue(p, id(p, which), body(p), actor)), () => viaApi('PATCH', `/issues/${id('through-api', which)}`, body('through-api'), actor)]
        for (const [name, ts, rs] of [
            edit('into a milestone', 'loose', p => ({milestone: id(p, 'rack')})),
            edit('into a release', 'loose', () => ({release: '3.0.0', title: 'Find the good saw'})),
            edit('under a parent, out of its milestone', 'loose', p => ({parent: id(p, 'mid')})),
            edit('the same parent again', 'loose', p => ({parent: id(p, 'mid')})),
            edit('lifted to the top, into its root\'s milestone', 'loose', () => ({parent: null})),
            edit('lifted into a milestone of its own', 'low', p => ({parent: null, milestone: id(p, 'rack')})),
            edit('out of its milestone and release', 'loose', () => ({milestone: null, release: null})),
            edit('a parent and a milestone at once', 'loose', p => ({parent: id(p, 'top'), milestone: id(p, 'shelf')})),
            edit('under itself', 'top', p => ({parent: id(p, 'top')})),
            edit('under its own sub-issue', 'top', p => ({parent: id(p, 'mid')})),
            edit('under one there isn\'t', 'loose', () => ({parent: 'KEY-999'})),
            edit('into a milestone there isn\'t', 'loose', () => ({milestone: '999'})),
            edit('into a release there isn\'t', 'loose', () => ({release: '9.9.9'})),
            edit('a parent that isn\'t a string', 'loose', () => ({parent: 7})),
            edit('a proposal\'s release by an agent', 'idea', () => ({release: '3.0.0'}), AGENT),
            edit('a proposal\'s release by the owner', 'idea', () => ({release: '3.0.0'})),
            [`loose's activity`, p => viaStore(() => store.listActivity(p, id(p, 'loose'))), () => viaApi('GET', `/issues/${id('through-api', 'loose')}/activity`)],
            [`low's activity`, p => viaStore(() => store.listActivity(p, id(p, 'low'))), () => viaApi('GET', `/issues/${id('through-api', 'low')}/activity`)],
        ] as Step[]) await both(name, ts, rs)
    })

    it('puts an issue in an epic and takes it out alike, by any form of its id (ORR-927, ORR-995)', async () => {
        const ids: Record<string, string> = {}
        for (const p of ['through-store', 'through-api']) ids[p] = (await store.createIssue(p, {title: 'Hang the clock'}, OWNER)).id
        const {id: epic} = await store.createEpic({title: 'The clock tower'}, OWNER)
        const uid = (await store.settings()).uid
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const edit = (name: string, body: unknown, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.updateIssue(p, ids[p]!, body, actor)), () => viaApi('PATCH', `/issues/${ids['through-api']}`, body, actor)]
        for (const [name, ts, rs] of [
            edit('into it by its number', {epic}),
            edit('into it again, by its shown id in lower case', {epic: `epc-${epic}`}),
            edit('out of it', {epic: null}),
            edit('into it by its full id, with a title', {epic: `EPC-${epic}-${uid}`, title: 'Hang the big clock'}),
            edit('by its number as a string', {epic: ` ${epic} `}),
            edit('into one there isn\'t', {epic: 9999}),
            edit('by another board\'s full id', {epic: `EPC-${epic}-aaaaaaaa`}),
            edit('by a name', {epic: 'The clock tower'}),
            edit('by a fraction', {epic: 1.5}),
            edit('by a blank', {epic: '  '}),
            edit('by an agent, with one person', {epic: null}, AGENT),
            ['the activity', p => viaStore(() => store.listActivity(p, ids[p]!)), () => viaApi('GET', `/issues/${ids['through-api']}/activity`)],
            ['the issue', p => viaStore(() => store.issue(p, ids[p]!)), () => viaApi('GET', `/issues/${ids['through-api']}`)],
        ] as Step[]) await both(name, ts, rs)
    })

    it('changes a proposal\'s choices alike, refusing what parseChoices refuses (ORR-927)', async () => {
        const ids: Record<string, string> = {}
        for (const p of ['through-store', 'through-api']) ids[p] = (await store.createIssue(p, {title: 'Which clock?', proposal: 'pending'})).id
        const two = [{key: 'A', title: ' Brass ', body: null}, {key: 'B', title: 'Oak', body: 'Darker'}]
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const edit = (name: string, body: unknown, actor: Actor = AGENT): Step =>
            [name, p => viaStore(() => store.updateIssue(p, ids[p]!, body, actor)), () => viaApi('PATCH', `/issues/${ids['through-api']}`, body, actor)]
        for (const [name, ts, rs] of [
            edit('two choices, one following on', {choices: [
                {key: 'case', question: ' What case? ', options: two, recommended: ['A']},
                {key: 'hands', question: 'Which hands?', pick: 'any', options: [{key: 'h', title: 'Hour'}, {key: 'm', title: 'Minute'}], from: {choice: 'case', option: 'B'}},
            ]}),
            ['the issue', p => viaStore(() => store.issue(p, ids[p]!)), () => viaApi('GET', `/issues/${ids['through-api']}`)],
            edit('none, with null', {choices: null, notes: 'Plain'}),
            edit('none, with an empty list', {choices: []}),
            edit('not a list', {choices: {key: 'a'}}),
            edit('one option', {choices: [{key: 'a', question: 'Q', options: [two[0]]}]}),
            edit('a bad key', {choices: [{key: '-a', question: 'Q', options: two}]}),
            edit('two recommended for pick one', {choices: [{key: 'a', question: 'Q', options: two, recommended: ['A', 'B']}]}),
            edit('a from with no choice before it', {choices: [{key: 'a', question: 'Q', options: two, from: {choice: 'a', option: 'A'}}]}),
            edit('with no question', {choices: [{key: 'a', options: two}]}),
            edit('a bad pick, with a bad title', {choices: [{key: 'a', question: 'Q', pick: 'all', options: two}], title: ''}),
            ['the activity', p => viaStore(() => store.listActivity(p, ids[p]!)), () => viaApi('GET', `/issues/${ids['through-api']}/activity`)],
            ['the issue after', p => viaStore(() => store.issue(p, ids[p]!)), () => viaApi('GET', `/issues/${ids['through-api']}`)],
        ] as Step[]) await both(name, ts, rs)
    })

    it('changes what an issue depends on alike, refusing itself, its parent, a sub-issue and a loop (ORR-927, ORR-601)', async () => {
        const ids: Record<string, Record<string, string>> = {}
        const key = (p: string) => p === 'through-store' ? 'STO' : 'API'
        for (const p of ['through-store', 'through-api']) {
            const make = async (title: string, more: Record<string, unknown> = {}) => (await store.createIssue(p, {title, ...more}, OWNER)).id
            const gear = await make('Cut the gear')
            ids[p] = {gear, axle: await make('Turn the axle'), case: await make('Close the case'), tooth: await make('File a tooth', {parent: gear}), pin: await make('Fit the pin')}
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${key(p)}-88`, ids[p]!.case)
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        /** An edit of `which`, its body naming each side's own issues: `$axle` for the axle's id. */
        const edit = (name: string, which: string, body: (p: string) => unknown, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.updateIssue(p, ids[p]![which]!, body(p), actor)), () => viaApi('PATCH', `/issues/${ids['through-api']![which]}`, body('through-api'), actor)]
        const on = (...names: string[]) => (p: string) => ({depends_on: names.map(n => n.replace(/\$(\w+)/, (_, w: string) => ids[p]![w]!).replace('OLD', `${key(p)}-88`))})
        for (const [name, ts, rs] of [
            edit('on the axle and the case, by an old id', 'gear', on('$axle', ' OLD ', '$axle')),
            edit('the same again', 'gear', on('$axle', '$case')),
            edit('the case dropped, the pin added, with a title', 'gear', p => ({...on('$axle', '$pin')(p), title: 'Cut the brass gear'})),
            edit('on itself', 'gear', on('$gear')),
            edit('a sub-issue on its parent', 'tooth', on('$gear')),
            edit('a parent on its sub-issue', 'gear', on('$tooth')),
            edit('the axle on the case', 'axle', on('$case')),
            edit('a loop through the axle', 'case', on('$gear')),
            edit('the case on the gear directly', 'pin', on('$gear')),
            edit('not an issue', 'pin', on('/X-1')),
            edit('one that isn\'t there', 'pin', on('$pin-9')),
            edit('another project there isn\'t', 'pin', on('nowhere/X-1')),
            edit('not a list', 'pin', () => ({depends_on: 'X-1'})),
            edit('cleared with null', 'gear', () => ({depends_on: null})),
            edit('cleared again with none', 'gear', () => ({depends_on: []})),
            [`the gear's activity`, p => viaStore(() => store.listActivity(p, ids[p]!.gear!)), () => viaApi('GET', `/issues/${ids['through-api']!.gear}/activity`)],
            [`the pin, read`, p => viaStore(() => store.issue(p, ids[p]!.pin!)), () => viaApi('GET', `/issues/${ids['through-api']!.pin}`)],
            [`the case, read`, p => viaStore(() => store.issue(p, ids[p]!.case!)), () => viaApi('GET', `/issues/${ids['through-api']!.case}`)],
        ] as Step[]) await both(name, ts, rs)
    })

    it('puts an issue to the owner and commits it alike, ending its claim, and pushes a P0 committed (ORR-927)', async () => {
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            const make = async (title: string, more: Record<string, unknown> = {}, actor: Actor = OWNER) => (await store.createIssue(p, {title, ...more}, actor)).id
            ids[p] = {
                held: await make('Set the hands', {assignee: 'claude'}),
                idea: await make('A second dial?', {proposal: 'pending'}, AGENT),
                hot: await make('Stop the drift', {proposal: 'pending', priority: 'P0'}, AGENT),
                redo: await make('A glass back?', {proposal: 'pending'}, AGENT),
            }
            await store.db.run("UPDATE issues SET claimed_by = 'owner', claimed_at = ? WHERE project = ? AND id = ?", new Date().toISOString(), p, ids[p]!.held)
            await store.db.run("UPDATE issues SET proposal = 'changes', decided_by = 'owner', decided_at = ?, decision_note = 'Smaller, please.' WHERE project = ? AND id = ?", new Date().toISOString(), p, ids[p]!.redo)
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const edit = (name: string, which: string, body: unknown, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.updateIssue(p, ids[p]![which]!, body, actor)), () => viaApi('PATCH', `/issues/${ids['through-api']![which]}`, body, actor)]
        const read = (which: string): Step => [`${which}, read`, p => viaStore(() => store.issue(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}`)]
        const activity = (which: string): Step =>
            [`${which}'s activity`, p => viaStore(() => store.listActivity(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}/activity`)]
        const signals = async (p: string) => (await store.db.all<{issue: string, kind: string, note: string | null}>('SELECT issue, kind, note FROM signals WHERE project = ? ORDER BY id', p))
            .map(r => `${r.kind} ${r.issue.replace(/^(STO|API)-/, 'KEY-')} ${r.note ?? ''}`)
        for (const [name, ts, rs] of [
            edit('a held one put to the owner, by an agent', 'held', {proposal: 'pending', notes: 'Is this still wanted?'}, AGENT),
            read('held'),
            edit('a proposal committed by an agent', 'idea', {proposal: null}, AGENT),
            edit('a proposal committed by the owner', 'idea', {proposal: null, title: 'A second dial'}),
            edit('committed again', 'idea', {proposal: null}),
            edit('a P0 proposal committed by the owner', 'hot', {proposal: null}),
            edit('one sent back for changes, put up again', 'redo', {proposal: 'pending', title: 'A small glass back?'}, AGENT),
            read('redo'),
            edit('not a proposal', 'idea', {proposal: 'changes'}),
            activity('held'),
            activity('idea'),
            activity('redo'),
        ] as Step[]) await both(name, ts, rs)
        await quiet()
        expect(await signals('through-api')).toEqual(await signals('through-store'))
        // Only the P0 proposal the owner committed is pushed, and nothing else this made.
        const hot = ids['through-api']!.hot!.replace(/^API-/, 'KEY-')
        const mine = new Set(Object.values(ids['through-api']!).map(id => id.replace(/^API-/, 'KEY-')))
        expect((await signals('through-api')).filter(s => mine.has(s.split(' ')[1]!))).toEqual([`focus ${hot} It was just made urgent (P0).`])
    })

    it('decides proposals alike: approved with picks or into Todo, changes asked for down an option, rejected, and refused (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const before = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM signals'))?.n ?? 0
        const choices = [
            {key: 'store', question: 'Which store?', options: [{key: 'A', title: 'SQLite'}, {key: 'B', title: 'Postgres'}], recommended: ['A']},
            {key: 'pool', question: 'How big a pool?', pick: 'any', options: [{key: 'small', title: 'Small'}, {key: 'large', title: 'Large'}], recommended: ['small'], from: {choice: 'store', option: 'B'}},
        ]
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            const make = async (title: string, more: Record<string, unknown> = {}, actor: Actor = AGENT) => (await store.createIssue(p, {title, ...more}, actor)).id
            ids[p] = {
                plain: await make('Oil the gears', {}, OWNER),
                idea: await make('A second dial?', {proposal: 'pending'}),
                hot: await make('Stop the drift', {proposal: 'pending', priority: 'P0'}),
                picked: await make('Where to keep the hours', {proposal: 'pending', choices}),
                guessed: await make('Where to keep the minutes', {proposal: 'pending', choices}),
                explored: await make('Where to keep the seconds', {proposal: 'pending', choices}),
                started: await make('Polish the case', {proposal: 'pending'}),
                nope: await make('A cuckoo', {proposal: 'pending'}),
            }
            await store.db.run("UPDATE issues SET status = 'in-progress' WHERE project = ? AND id = ?", p, ids[p]!.started)
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const decide = (name: string, which: string, body: unknown, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.decide(p, ids[p]![which]!, body, actor)), () => viaApi('POST', `/issues/${ids['through-api']![which]}/decide`, body, actor)]
        const read = (which: string): Step => [`${which}, read`, p => viaStore(() => store.issue(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}`)]
        const activity = (which: string): Step =>
            [`${which}'s activity`, p => viaStore(() => store.listActivity(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}/activity`)]
        const comments = (which: string): Step =>
            [`${which}'s comments`, p => viaStore(() => store.listComments(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}/comments`)]
        for (const [name, ts, rs] of [
            decide('by an agent', 'idea', {decision: 'approved'}, AGENT),
            decide('by an untrusted session', 'idea', {decision: 'approved'}, {name: 'stranger', owner: false, untrusted: true}),
            decide('not a proposal', 'plain', {decision: 'approved'}),
            decide('no body', 'idea', undefined),
            decide('no decision', 'idea', {}),
            decide('one that isn\'t', 'idea', {decision: 'maybe'}),
            decide('several problems', 'idea', {decision: 3, note: 4, picks: 'A', explore: {choice: 1}, extra: true}),
            decide('picks that aren\'t lists', 'picked', {decision: 'approved', picks: {store: 'A'}}),
            decide('picks with a rejection', 'picked', {decision: 'rejected', picks: {store: ['A']}}),
            decide('picks where there are no choices', 'idea', {decision: 'approved', picks: {store: ['A']}}),
            decide('explore with an approval', 'explored', {decision: 'approved', explore: {choice: 'store', option: 'A'}}),
            decide('a choice that isn\'t there', 'picked', {decision: 'approved', picks: {size: ['A']}}),
            decide('an option that isn\'t there', 'picked', {decision: 'approved', picks: {store: ['C']}}),
            decide('two for a pick one', 'picked', {decision: 'approved', picks: {store: ['A', 'B']}}),
            decide('down an option that isn\'t there', 'explored', {decision: 'changes', explore: {choice: 'store', option: 'C'}}),
            decide('approved with picks and a note', 'picked', {decision: 'approved', picks: {store: ['B'], pool: ['large', 'small', 'large']}, note: '  Go.  '}),
            decide('approved on its recommendations', 'guessed', {decision: 'approved', note: ' '}),
            decide('approved, into Todo', 'idea', {decision: 'approved'}),
            decide('approved again', 'idea', {decision: 'approved'}),
            decide('an urgent one approved', 'hot', {decision: 'approved'}),
            decide('one already started approved', 'started', {decision: 'approved'}),
            decide('changes down an option', 'explored', {decision: 'changes', explore: {choice: 'store', option: 'B'}, note: 'Price it.'}),
            decide('changes again', 'explored', {decision: 'changes'}),
            decide('rejected', 'nope', {decision: 'rejected', note: 'Too loud.'}),
            ...['picked', 'guessed', 'idea', 'hot', 'started', 'explored', 'nope'].flatMap(which => [read(which), activity(which), comments(which)]),
        ] as Step[]) await both(name, ts, rs)
        await quiet()
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        const signals = async (p: string) => (await store.db.all<{issue: string, kind: string, note: string | null}>('SELECT issue, kind, note FROM signals WHERE project = ? AND id > ? ORDER BY id', p, before))
            .map(r => `${r.kind} ${r.issue.replace(/^(STO|API)-/, 'KEY-')} ${r.note ?? ''}`)
        expect(await signals('through-api')).toEqual(await signals('through-store'))
        // An urgent one approved is pushed as the store pushes it, its guards and all: on a board with more than one person,
        // one given back to an agent that's nobody's stays put (ORR-656), so how many depends on the tests before.
    })

    it('decides many proposals alike, each on its own, refusing a guess at picks (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const before = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM signals'))?.n ?? 0
        const key = (p: string) => p === 'through-store' ? 'STO' : 'API'
        const options = [{key: 'A', title: 'Brass'}, {key: 'B', title: 'Steel'}]
        const ids: Record<string, Record<string, string>> = {}
        for (const p of ['through-store', 'through-api']) {
            const make = async (title: string, more: Record<string, unknown> = {}, actor: Actor = AGENT) => (await store.createIssue(p, {title, ...more}, actor)).id
            ids[p] = {
                one: await make('A brass bezel', {proposal: 'pending'}),
                two: await make('A steel crown', {proposal: 'pending', priority: 'P0'}),
                sure: await make('Which metal?', {proposal: 'pending', choices: [{key: 'metal', question: 'Which metal?', options, recommended: ['A']}]}),
                unsure: await make('Which finish?', {proposal: 'pending', choices: [{key: 'finish', question: 'Which finish?', options}]}),
                plain: await make('Wind it', {}, OWNER),
                later: await make('A moon dial', {proposal: 'pending'}),
            }
            await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', p, `${key(p)}-93`, ids[p]!.one)
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const decide = (name: string, body: (p: string) => unknown, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.decideIssues(p, body(p), actor)), () => viaApi('POST', '/issues/decide', body('through-api'), actor)]
        const steps: Step[] = [
            decide('no ids', () => ({decision: 'approved'})),
            decide('an empty list', () => ({ids: [], decision: 'approved'})),
            decide('with picks', p => ({ids: [ids[p]!.sure], decision: 'approved', picks: {metal: ['B']}})),
            decide('with explore and no ids', () => ({decision: 'changes', explore: {choice: 'metal', option: 'A'}})),
            decide('by an agent', p => ({ids: [ids[p]!.one], decision: 'approved'}), AGENT),
            decide('no decision', p => ({ids: [ids[p]!.one]})),
            decide('approved: by an id it had, twice, an urgent one, one with picks, one without, one not a proposal and one not there',
                p => ({ids: [`${key(p)}-93`, ids[p]!.two, `${key(p)}-93`, ids[p]!.sure, ids[p]!.unsure, ids[p]!.plain, 'X-404'], decision: 'approved', note: 'All good.'})),
            decide('changes asked for, where there are no picks to guess', p => ({ids: [ids[p]!.unsure], decision: 'changes'})),
            decide('rejected', p => ({ids: [ids[p]!.later], decision: 'rejected', note: 'Not now.'})),
            ['in a project that isn\'t there', () => viaStore(() => store.decideIssues('nowhere', {ids: ['X-1'], decision: 'approved'}, OWNER)), () => viaApi('POST', '/issues/decide', {ids: ['X-1'], decision: 'approved'}, OWNER, 'nowhere')],
        ]
        for (const [name, ts, rs] of steps) await both(name, ts, rs)
        await quiet()
        await both('the board after', p => viaStore(async () => (await store.listIssues(p)).map(i => `${i.title} ${i.status} ${i.assignee} ${i.proposal ?? ''}`).sort()), async () => {
            const outcome = await viaApi('GET', '/issues')
            return {...outcome, body: (outcome.body as {title: string, status: string, assignee: string, proposal?: string}[]).map(i => `${i.title} ${i.status} ${i.assignee} ${i.proposal ?? ''}`).sort()}
        })
        for (const which of ['one', 'two', 'sure', 'unsure', 'later']) {
            await both(`${which}'s comments`, p => viaStore(() => store.listComments(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}/comments`))
        }
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        const signals = async (p: string) => (await store.db.all<{issue: string, kind: string, note: string | null}>('SELECT issue, kind, note FROM signals WHERE project = ? AND id > ? ORDER BY id', p, before))
            .map(r => `${r.kind} ${r.issue.replace(/^(STO|API)-/, 'KEY-')} ${r.note ?? ''}`)
        expect(await signals('through-api')).toEqual(await signals('through-store'))
    })

    it('changes an issue\'s status and assignee alike, ending a claim, with the rails between people, and pushes a P0 opened again (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const ids: Record<string, Record<string, string>> = {}
        const claimed = async (p: string, id: string) => store.db.run("UPDATE issues SET claimed_by = 'steffen', claimed_at = ? WHERE project = ? AND id = ?", new Date().toISOString(), p, id)
        for (const p of ['through-store', 'through-api']) {
            const make = async (title: string, more: Record<string, unknown> = {}, actor: Actor = OWNER) => (await store.createIssue(p, {title, ...more}, actor)).id
            ids[p] = {
                gear: await make('Cut the gear'),
                held: await make('Set the hands', {assignee: 'claude'}),
                kept: await make('Oil the hinge', {assignee: 'claude'}),
                hot: await make('Stop the drift', {priority: 'P0', status: 'done'}),
                idea: await make('A second dial?', {proposal: 'pending'}, AGENT),
            }
            await claimed(p, ids[p]!.held!)
            await claimed(p, ids[p]!.kept!)
        }
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const edit = (name: string, which: string, body: unknown, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.updateIssue(p, ids[p]![which]!, body, actor)), () => viaApi('PATCH', `/issues/${ids['through-api']![which]}`, body, actor)]
        const read = (which: string): Step => [`${which}, read`, p => viaStore(() => store.issue(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}`)]
        const activity = (which: string): Step =>
            [`${which}'s activity`, p => viaStore(() => store.listActivity(p, ids[p]![which]!)), () => viaApi('GET', `/issues/${ids['through-api']![which]}/activity`)]
        const signals = async (p: string) => (await store.db.all<{issue: string, kind: string, note: string | null}>('SELECT issue, kind, note FROM signals WHERE project = ? ORDER BY id', p))
            .map(r => `${r.kind} ${r.issue.replace(/^(STO|API)-/, 'KEY-')} ${r.note ?? ''}`)
        for (const [name, ts, rs] of [
            edit('started by its kind', 'gear', {status: 'started'}),
            edit('to a status by its id, with a title', 'gear', {status: 'in-review', title: 'Cut the brass gear'}),
            edit('by an old word', 'gear', {status: 'doing'}),
            edit('the same status again', 'gear', {status: 'doing'}),
            edit('a plan', 'gear', {plan: 'now'}),
            edit('no plan, with todo', 'gear', {status: 'todo', plan: null}),
            edit('a status there isn\'t', 'gear', {status: 'soon'}),
            edit('a null status and a bad plan', 'gear', {status: null, plan: 'soon'}),
            edit('a status that isn\'t a string', 'gear', {status: 3}),
            edit('given to the owner', 'gear', {assignee: ' Owner '}),
            edit('given to claude', 'gear', {assignee: 'claude'}),
            edit('given to nobody, by a blank', 'gear', {assignee: '  '}),
            edit('given to claude again, by an agent', 'gear', {assignee: 'claude'}, AGENT),
            edit('let go of with null', 'gear', {assignee: null}),
            edit('a held one closed, by an agent', 'held', {status: 'done'}, AGENT),
            read('held'),
            edit('a held one reassigned', 'kept', {assignee: 'steffen'}),
            read('kept'),
            edit('a closed P0 opened again', 'hot', {status: 'todo'}),
            edit('a waiting proposal started, by an agent', 'idea', {status: 'started'}, AGENT),
            edit('a waiting proposal moved and given, by an agent', 'idea', {plan: null, assignee: 'claude', release: '3.0.0'}, AGENT),
            edit('a waiting proposal put up again with an assignee, by an agent', 'idea', {proposal: 'pending', assignee: 'claude'}, AGENT),
            edit('a waiting proposal started, by the owner', 'idea', {status: 'started'}),
            activity('gear'),
            activity('held'),
            activity('hot'),
        ] as Step[]) await both(name, ts, rs)
        // Two people: an agent starts, closes and hands on only its person's, and gives one only back to the owner.
        await store.addPerson({name: 'Hal'})
        const HALS: Actor = {name: 'agent', owner: false, session: 'orrery · Hal', asked: true, named: 'hal'}
        for (const p of ['through-store', 'through-api']) {
            ids[p] = {...ids[p], hals: (await store.createIssue(p, {title: 'Count the teeth', assignee: 'hal'}, OWNER)).id, mine: (await store.createIssue(p, {title: 'Wind it'}, OWNER)).id}
        }
        for (const [name, ts, rs] of [
            edit('Hal\'s, started by Hal\'s agent', 'hals', {status: 'started'}, HALS),
            read('hals'),
            edit('Hal\'s, given to claude by Hal\'s agent', 'hals', {assignee: 'claude'}, HALS),
            edit('Hal\'s, given to someone else by Hal\'s agent', 'hals', {assignee: 'zed'}, HALS),
            edit('Hal\'s, given back to the owner by Hal\'s agent', 'hals', {assignee: 'owner', status: 'todo'}, HALS),
            read('hals'),
            edit('the owner\'s, started by Hal\'s agent', 'mine', {status: 'started'}, HALS),
            activity('hals'),
        ] as Step[]) await both(name, ts, rs)
        await store.db.run("UPDATE issues SET assignee = NULL WHERE assignee = 'hal'")
        await store.db.run("UPDATE issues SET claimed_by = NULL WHERE claimed_by = 'hal'")
        await store.db.run("DELETE FROM people WHERE id = 'hal'")
        await quiet()
        expect(await signals('through-api')).toEqual(await signals('through-store'))
        // The P0 opened again by the owner is pushed, and nothing else this made.
        const hot = ids['through-api']!.hot!.replace(/^API-/, 'KEY-')
        const mine = new Set(Object.values(ids['through-api']!).map(id => id.replace(/^API-/, 'KEY-')))
        expect((await signals('through-api')).filter(s => mine.has(s.split(' ')[1]!) && s.startsWith('focus '))).toEqual([`focus ${hot} It was just made urgent (P0).`])
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        expect((await rows('through-api')).filter(row => row.startsWith('issue.status ')).length).toBeGreaterThan(4)
    })

    it('makes an issue alike, with the rails between people, noting and telling it, and pushes a P0 (ORR-927)', async () => {
        const start = (await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM changes'))?.n ?? 0
        const parents: Record<string, string> = {}
        for (const p of ['through-store', 'through-api']) parents[p] = (await store.createIssue(p, {title: 'The case'}, OWNER)).id
        type Step = [string, (p: string) => Promise<Outcome>, () => Promise<Outcome>]
        const make = (name: string, body: (p: string) => unknown, actor: Actor = OWNER): Step =>
            [name, p => viaStore(() => store.createIssue(p, body(p), actor), 201), () => viaApi('POST', '/issues', body('through-api'), actor)]
        const plain = (body: unknown) => () => body
        for (const [name, ts, rs] of [
            make('with a title alone', plain({title: '  Cut the gear  '})),
            make('with its words', plain({title: 'Set the hands', priority: 'P2', labels: ['b', ' a', 'b'], external: [' ask ', ''], notes: 'Gently', model: 'opus', effort: 'high', position: 7})),
            make('in a status by its kind, given to the owner', plain({title: 'Oil the hinge', status: 'started', assignee: ' owner '})),
            make('by an old word and a plan', plain({title: 'Wind it', status: 'todo', plan: 'next'})),
            make('under a parent', p => ({title: 'Count the teeth', parent: parents[p]})),
            make('under a parent and in a milestone', p => ({title: 'Both', parent: parents[p], milestone: '1'})),
            make('under a parent it depends on', p => ({title: 'Loop', parent: parents[p], depends_on: [parents[p]]})),
            make('depending on one', p => ({title: 'After the case', depends_on: [parents[p]]})),
            make('under a parent there isn\'t', plain({title: 'Lost', parent: 'KEY-999'})),
            make('in a milestone there isn\'t', plain({title: 'Lost', milestone: '999'})),
            make('in an epic there isn\'t', plain({title: 'Lost', epic: 999})),
            make('in a release, with none', plain({title: 'Lost', release: '9.9.9'})),
            make('a P0', plain({title: 'Stop the drift', priority: 'P0'})),
            make('a P0, closed', plain({title: 'Stopped', priority: 'P0', status: 'done'})),
            make('a proposal, by an agent', plain({title: 'A second dial?', proposal: 'pending', assignee: 'claude', priority: 'P0'}), AGENT),
            make('with no title', plain({priority: 'P1'})),
            make('with a blank title and bad words', plain({title: ' ', status: 3, effort: 'huge'})),
            make('with a status there isn\'t', plain({title: 'Soon', status: 'soon'})),
            make('that isn\'t an object', plain([])),
        ] as Step[]) await both(name, ts, rs)
        // Two people: an agent files one under its person's issue, and one at the top only nobody's, in Todo or Backlog.
        await store.addPerson({name: 'Hal'})
        const HALS: Actor = {name: 'agent', owner: false, session: 'orrery · Hal', asked: true, named: 'hal'}
        for (const p of ['through-store', 'through-api']) await store.updateIssue(p, parents[p]!, {assignee: 'hal'}, OWNER)
        for (const [name, ts, rs] of [
            make('under Hal\'s, started, by Hal\'s agent', p => ({title: 'Follow up', parent: parents[p], status: 'started'}), HALS),
            make('at the top, by Hal\'s agent', plain({title: 'An idea'}), HALS),
            make('at the top, started, by Hal\'s agent', plain({title: 'Taken', status: 'started'}), HALS),
            make('at the top, given to someone, by Hal\'s agent', plain({title: 'Given', assignee: 'zed'}), HALS),
            make('at the top, given to claude, by Hal\'s agent', plain({title: 'Given', assignee: 'claude'}), HALS),
            make('at the top, given to the owner, by Hal\'s agent', plain({title: 'Given back', assignee: 'owner'}), HALS),
        ] as Step[]) await both(name, ts, rs)
        await store.db.run("UPDATE issues SET assignee = NULL WHERE assignee = 'hal'")
        await store.db.run("UPDATE issues SET claimed_by = NULL WHERE claimed_by = 'hal'")
        await store.db.run("UPDATE issues SET created_person = NULL WHERE created_person = 'hal'")
        await store.db.run("DELETE FROM people WHERE id = 'hal'")
        await quiet()
        const rows = async (p: string) => (await store.db.all<{kind: string, payload: string | null}>('SELECT kind, payload FROM changes WHERE project = ? AND id > ? ORDER BY id', p, start))
            .map(r => `${r.kind} ${(r.payload ?? '').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2')}`).sort()
        expect(await rows('through-api')).toEqual(await rows('through-store'))
        expect((await rows('through-api')).filter(row => row.startsWith('issue.created ')).length).toBeGreaterThan(8)
    })

    it('removes a person alike: their open issues unassigned and told, their seats the owner\'s, their keys and logins ended (ORR-928)', async () => {
        /** A member with work on `p`: a seat on its board, an open issue and a done one, a key and a login. */
        const hire = async (p: string) => {
            await store.addPerson({name: 'Hal'})
            await store.db.run("INSERT INTO project_members (project, person, role, created_at) VALUES (?, 'hal', 'member', ?)", p, new Date().toISOString())
            const open = (await store.createIssue(p, {title: 'Hal\'s open one', assignee: 'hal'}, OWNER)).id
            const done = (await store.createIssue(p, {title: 'Hal\'s done one', assignee: 'hal', status: 'done'}, OWNER)).id
            await store.makeKey('hal', {kind: 'person', name: 'Laptop'})
            await store.startLogin('hal')
            return {open, done}
        }
        /** What the removal left on `p`. */
        const left = async (p: string, issues: {open: string, done: string}) => ({
            removed: !!(await store.people()).find(person => person.id === 'hal')?.removed_at,
            keys: (await store.keys('hal')).map(key => !!key.revoked_at),
            logins: (await store.logins('hal')).length,
            seats: await store.db.all('SELECT person, role FROM project_members WHERE project = ? ORDER BY person', p),
            assignees: [(await store.issue(p, issues.open)).assignee ?? null, (await store.issue(p, issues.done)).assignee ?? null],
            noted: await store.db.all("SELECT issue, field, before, after, created_by FROM issue_events WHERE project = ? AND field = 'assignee' AND after IS NULL ORDER BY id", p),
        })
        /** Hal gone without a trace, so the other side hires them afresh. */
        const fire = async () => {
            for (const table of ['keys', 'logins', 'invites', 'project_members']) await store.db.run(`DELETE FROM ${table} WHERE person = 'hal'`)
            await store.db.run("DELETE FROM people WHERE id = 'hal'")
        }
        const sides: Record<string, {outcome: Outcome, left: unknown}> = {}
        for (const p of ['through-store', 'through-api']) {
            const issues = await hire(p)
            await quiet()
            const outcome = p === 'through-store'
                ? await viaStore(() => store.removePerson('hal', OWNER), 204)
                : await viaApi('DELETE', '/api/people/hal', undefined, OWNER)
            // Removed again, nothing more happens.
            const again = p === 'through-store' ? await viaStore(() => store.removePerson('hal', OWNER), 204) : await viaApi('DELETE', '/api/people/hal', undefined, OWNER)
            expect(again, `${p}: removed again`).toMatchObject({status: 204, changed: [], told: []})
            sides[p] = {outcome, left: await left(p, issues)}
            await fire()
        }
        const a = sides['through-store']!, b = sides['through-api']!
        expect(same(b.outcome, 'through-api')).toEqual(same(a.outcome, 'through-store'))
        expect(same(b.left as Outcome, 'through-api')).toEqual(same(a.left as Outcome, 'through-store'))
        expect(b.outcome).toMatchObject({status: 204, changed: expect.arrayContaining(['through-api']), told: [expect.stringMatching(/^issue\.assignee API-\d+$/)]})
        expect(b.left).toMatchObject({removed: true, keys: [true], logins: 0, assignees: [null, 'hal']})
        // The owner, nobody, and a session are refused alike.
        await both('the owner', () => viaStore(() => store.removePerson('steffen', OWNER)), () => viaApi('DELETE', '/api/people/steffen', undefined, OWNER))
        await both('nobody', () => viaStore(() => store.removePerson('nobody', OWNER)), () => viaApi('DELETE', '/api/people/nobody', undefined, OWNER))
        expect((await viaApi('DELETE', '/api/people/ada', undefined, SESSION)).body).toEqual({message: refused(permission('people.write'), 'session').message, data: {permission: 'people.write'}})
        expect((await store.people()).find(person => person.id === 'ada')?.removed_at).toBeUndefined()
    })

    it('serves an uploaded image alike, with the headers that keep it an image (ORR-927)', async () => {
        const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
        const {id} = await store.createUpload({data: PNG, name: 'dot.png'}, OWNER)
        const kept = await store.upload(id)
        const response = await fetch(`${url}/api/uploads/${id}`, {headers: {'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...actorHeaders(AGENT)}})
        const passed = await passedThrough(response)
        expect(passed?.body.equals(kept.data)).toBe(true)
        // As web/server/api/uploads/[upload].get.ts sets them.
        expect(passed?.headers).toEqual({
            'content-type': kept.type, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; sandbox",
        })
        await both('one that isn\'t there', () => viaStore(() => store.upload('0'.repeat(24))), () => viaApi('GET', `/api/uploads/${'0'.repeat(24)}`))
        await both('not an image\'s id', () => viaStore(() => store.upload('../x')), () => viaApi('GET', '/api/uploads/..%2Fx'))
        // A failure is JSON, thrown again by the router rather than passed through.
        expect(await passedThrough(await fetch(`${url}/api/uploads/nope`, {headers: {'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting)}}))).toBeUndefined()
    })

    it('exports a board alike, as one file named for the project and the day (ORR-1006)', async () => {
        // An image its text shows goes in the file, in base64, so the board takes one in an issue and a comment.
        const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
        const {id: image} = await store.createUpload({data: PNG, name: 'export.png'}, OWNER)
        // On both projects, so their issues keep the same numbers for the steps after.
        for (const project of ['through-store', 'through-api']) {
            const {id: issue} = await store.createIssue(project, {title: 'Varnish the lid', notes: `![lid](/api/uploads/${image})`, assignee: 'owner'}, OWNER)
            await store.createComment(project, issue, {body: `Before: ![lid](/api/uploads/${image})`}, OWNER)
        }
        const response = await fetch(`${url}/api/projects/through-api/export`, {headers: {'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...actorHeaders(AGENT)}})
        const file = await response.json() as {exported_at: string, uploads: {id: string, data: string}[]}
        const kept = await exportBoard(store.db, 'through-api')
        expect(file.exported_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
        expect({...file, exported_at: ''}).toEqual(JSON.parse(JSON.stringify({...kept, exported_at: ''})))
        expect(file.uploads.map(upload => [upload.id, upload.data])).toEqual([[image, Buffer.from((await store.upload(image)).data).toString('base64')]])
        // As web/server/api/projects/[project]/export.get.ts names it, and the router passes it on.
        expect(response.headers.get('content-disposition')).toBe(`attachment; filename="through-api-${file.exported_at.slice(0, 10)}.orrery.json"`)
        await both('no such project', () => viaStore(() => store.project('nowhere')), () => viaApi('GET', '/api/projects/nowhere/export'))
        expect(domainOf('GET', '/api/projects/through-api/export')).toBe('a project, exported')
    })

    it('imports a roadmap alike, with the project\'s ids and the file\'s as aliases (ORR-1006)', async () => {
        // On projects of their own, so replacing a roadmap leaves the others' issues be.
        const on = (p: string) => `${p}-import`
        for (const p of ['through-store', 'through-api']) await store.createProject({name: on(p), key: p === 'through-store' ? 'STOI' : 'APII'})
        // As web/server/api/projects/[project]/import.post.ts checks the file first.
        const imported = (p: string, file: unknown, replace = false, actor: Actor = AGENT) => viaStore(async () => {
            let roadmap
            try {
                roadmap = checkRoadmap(file)
            } catch (error) {
                if (error instanceof RoadmapError) throw badRequest(error.message, error.details)
                throw error
            }
            return await store.importRoadmap(on(p), roadmap, replace, actor)
        })
        // The two projects' own key and uid differ, as they're two projects; what's on their boards doesn't.
        const unkeyed = async (outcome: Promise<Outcome>) => {
            const {body, ...rest} = await outcome
            return {...rest, body: body && typeof body === 'object' && 'uid' in body ? {...body, key: '<key>', uid: '<uid>'} : body}
        }
        const roadmap = {milestones: [
            {id: 'first', title: 'First', summary: 'The start', tasks: [
                {id: 'a', title: 'Plan', status: 'done', labels: ['x'], tasks: [{id: 'a1', title: 'Sketch', status: 'doing'}]},
                {id: 'b', title: 'Build', status: 'todo', plan: 'now', priority: 'P1', notes: 'Soon'},
            ]},
            {id: 'second', title: 'Second', tasks: [{id: 'c', title: 'Ship'}]},
        ]}
        const path = `/api/projects/${on('through-api')}/import`
        await both('a roadmap', p => unkeyed(imported(p, roadmap, false, OWNER)), () => unkeyed(viaApi('POST', path, roadmap, OWNER)))
        await both('again, without replace', p => imported(p, roadmap), () => viaApi('POST', path, roadmap))
        await both('replacing what the owner made, as an agent', p => imported(p, roadmap, true), () => viaApi('POST', `${path}?replace=true`, roadmap))
        await both('replacing it, as the owner', p => unkeyed(imported(p, {milestones: [{id: 'm', title: 'Only', tasks: [{id: 'b', title: 'Again'}]}]}, true, OWNER)),
            () => unkeyed(viaApi('POST', `${path}?replace=true`, {milestones: [{id: 'm', title: 'Only', tasks: [{id: 'b', title: 'Again'}]}]}, OWNER)))
        const bad = {milestones: [{id: 'm', title: 'M', tasks: [{id: 't', title: 'T', status: 'maybe', colour: 'red'}, {id: 't', title: 3}]}, {title: 'No id'}, 'x'], extra: 1}
        await both('a file with problems', p => imported(p, bad), () => viaApi('POST', path, bad))
        await both('not a roadmap', p => imported(p, [1]), () => viaApi('POST', path, [1]))
        await both('no such project', () => viaStore(() => store.importRoadmap('nowhere', {comment: '', milestones: []})), () => viaApi('POST', '/api/projects/nowhere/import', {milestones: []}))
        expect(domainOf('POST', path)).toBe('a project, imported')
    })

    it('reads the secrets alike, and never a value (ORR-953)', async () => {
        const secrets = new Secrets(store, () => 'parity-secret-key', undefined, async () => new Response('ok', {status: 200}))
        await alike0('none yet', () => viaStore(() => secrets.list()), () => viaApi('GET', '/api/secrets'))
        await secrets.set('STRIPE_KEY', {value: 'sk_live_0123456789', hosts: ['api.stripe.com']}, OWNER)
        await secrets.set('DEPLOY_TOKEN', {value: 'deploy-0123456789', hosts: ['deploy.lan:8443', 'https://ci.example/x'], projects: ['through-api']}, OWNER)
        await alike0('never used', () => viaStore(() => secrets.list()), () => viaApi('GET', '/api/secrets'))
        await secrets.egress({url: 'https://api.stripe.com/v1/charges?key={{secret:STRIPE_KEY}}', method: 'POST', body: {a: 1}, issue: 'API-1'}, AGENT)
        await secrets.egress({url: 'https://api.stripe.com/v1/refunds', headers: {Authorization: 'Bearer {{secret:STRIPE_KEY}}'}}, SESSION)
        await secrets.own('https://deploy.lan:8443/hook', 'DEPLOY_TOKEN', 'through-api')
        await alike0('used', () => viaStore(() => secrets.list()), () => viaApi('GET', '/api/secrets'))
        await alike0('one, with its uses', () => viaStore(() => secrets.get('STRIPE_KEY')), () => viaApi('GET', '/api/secrets/STRIPE_KEY'))
        await alike0('one kept to a project', () => viaStore(() => secrets.get('DEPLOY_TOKEN')), () => viaApi('GET', '/api/secrets/DEPLOY_TOKEN'))
        await alike0('none by that name', () => viaStore(() => secrets.get('NOPE')), () => viaApi('GET', '/api/secrets/NOPE'))
        const answer = JSON.stringify([await viaApi('GET', '/api/secrets'), await viaApi('GET', '/api/secrets/STRIPE_KEY')])
        for (const value of ['sk_live_0123456789', 'deploy-0123456789', 'v1:']) expect(answer).not.toContain(value)
    })

    it('reads one pull request alike, without what an outsider wrote for anyone but the owner (ORR-952)', async () => {
        const pulls = new Pulls(store, async () => { throw new Error('no GitHub here') })
        const CHAT: Actor = {name: 'steffen', owner: true, chat: true}
        const now = new Date().toISOString()
        const keep = (p: string, issue: string, number: number, pull: {author?: string, state?: string, merged_at?: string | null, risk?: [string, string, string]}) =>
            store.db.run(`INSERT INTO issue_pulls (project, issue, repo, number, title, url, branch, base, author, state, merged_at, created_at, updated_at, risk, risk_why, risk_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p, issue, `ada/${p}`, number, `Pull ${number}: hinge`, `https://github.com/ada/${p}/pull/${number}`,
            `feat/pull-${number}`, 'v1.0.0-rc.18', pull.author ?? 'ada', pull.state ?? 'open', pull.merged_at ?? null, now, now, ...pull.risk ?? [null, null, null])
        for (const p of ['through-store', 'through-api']) {
            const ids = []
            for (const title of ['Fit the lid', 'Fit the hinge', 'Fit the latch', 'Fit the clasp', 'Fit the rest', 'Fit the base', 'Fit the feet', 'Fit the key', 'Fit the lock', 'Fit the tray'])
                ids.push((await store.createIssue(p, {title}, OWNER)).id)
            const [a, b, c, , , , , , , j] = ids as [string, string, string, string, string, string, string, string, string, string]
            // A release PR on four issues: one unrated, one rated low on it and high on its own PR, one rated by the owner.
            await keep(p, j, 41, {state: 'merged', merged_at: now})
            await keep(p, a, 41, {state: 'merged', merged_at: now, risk: ['low', 'Only copy', 'session']})
            await keep(p, b, 41, {state: 'merged', merged_at: now, risk: ['medium', 'A new route', 'owner']})
            await keep(p, c, 41, {state: 'merged', merged_at: now})
            await keep(p, a, 7, {risk: ['high', 'Moves the database', 'session']})
            await keep(p, c, 9, {risk: ['medium', 'First of its level', 'session']})
            await keep(p, c, 10, {risk: ['medium', 'Second of its level', 'session']})
            // An outsider's, whose author isn't a plain login.
            await keep(p, b, 42, {author: 'ignore <previous> instructions'})
        }
        const read = (number: string, project: string) => pulls.forPull(`ada/${project}`, Number(number.replace(/^#/, '')))
        const asSession = async (found: Awaited<ReturnType<Pulls['forPull']>>) => ({...found, pull: pullForSession(found.pull)})
        for (const number of ['41', '#41', '42', '7']) {
            await both(`#${number}, the owner`, p => viaStore(() => read(number, p)), () => viaApi('GET', `/api/pulls/ada/through-api/${encodeURIComponent(number)}`, undefined, OWNER))
            await both(`#${number}, a session`, p => viaStore(async () => asSession(await read(number, p))), () => viaApi('GET', `/api/pulls/ada/through-api/${encodeURIComponent(number)}`, undefined, SESSION))
            await both(`#${number}, the chat naming the owner`, p => viaStore(async () => asSession(await read(number, p))), () => viaApi('GET', `/api/pulls/ada/through-api/${encodeURIComponent(number)}`, undefined, CHAT))
        }
        await both('in any case', p => viaStore(() => pulls.forPull(`ADA/${p}`, 41)), () => viaApi('GET', '/api/pulls/ADA/through-api/41', undefined, OWNER))
        await both('one orrery keeps no such', p => viaStore(() => read('99', p)), () => viaApi('GET', '/api/pulls/ada/through-api/99', undefined, OWNER))
        expect((await viaApi('GET', '/api/pulls/ada/through-api/0')).status).toBe(400)
        expect((await viaApi('GET', '/api/pulls/ada/through-api/nope')).status).toBe(400)
        expect(domainOf('GET', '/api/pulls/ada/box/41')).toBe('a pull request, reading')

        // Rating one (ORR-952), as the risk route does, on the issues above: #41 is on a, b (the owner's rating) and c.
        const listed = {'through-store': await store.listIssues('through-store'), 'through-api': await store.listIssues('through-api')}
        const on = (p: string, title: string) => known(listed[p as keyof typeof listed].find(i => i.title === title), title).id
        const rate = (title: string, number: string, body: unknown, actor: Actor = SESSION) => both(`${title} #${number} ${JSON.stringify(body)}`,
            p => viaStore(() => pulls.rateAsAsked(p, on(p, title), `ada/${p}`, number, body, actor.owner && !actor.chat)),
            () => viaApi('PUT', `/issues/${on('through-api', title)}/pulls/ada/through-api/${encodeURIComponent(number)}/risk`, body, actor))
        const outcomes = [
            await rate('Fit the latch', '41', {level: 'high', why: '  Moves the poll  '}),
            await rate('Fit the latch', '#41', {level: 'low', why: 'x'.repeat(320)}),
            await rate('Fit the hinge', '41', {level: 'low', why: 'Only copy'}),
            await rate('Fit the hinge', '41', {level: null}),
            await rate('Fit the hinge', '41', {level: 'high', why: 'Mine to say'}, OWNER),
            await rate('Fit the hinge', '41', {level: 'high', why: 'The chat naming the owner'}, CHAT),
            await rate('Fit the lid', '41', {level: null}),
            await rate('Fit the lid', '41', {level: 'medium'}),
            await rate('Fit the lid', '41', {level: 'huge', why: 'x', by: 'me'}),
            await rate('Fit the lid', '41', {why: 5}),
            await rate('Fit the lid', '0', {level: null}),
            await rate('Fit the lid', '99', {level: 'low', why: 'Not kept'}),
            await rate('Fit the key', '41', {level: 'low', why: 'Not on it'}),
            await both('an issue that isn\'t there', p => viaStore(() => pulls.rateAsAsked(p, 'NOPE-1', `ada/${p}`, '41', {level: null}, false)),
                () => viaApi('PUT', '/issues/NOPE-1/pulls/ada/through-api/41/risk', {level: null})),
            await both('the PR after', p => viaStore(() => read('41', p)), () => viaApi('GET', '/api/pulls/ada/through-api/41', undefined, OWNER)),
        ]
        // The steps compared something: what was rated, told and refused.
        expect(outcomes[0]).toMatchObject({status: 200, body: {risk: {level: 'high', why: 'Moves the poll', by: 'session'}}, changed: ['through-api', 'through-api-drawing']})
        expect((outcomes[1]!.body as {risk: {why: string}}).risk.why).toHaveLength(300)
        expect(outcomes[2]).toMatchObject({status: 409})
        expect(outcomes[3]).toMatchObject({status: 409})
        expect(outcomes[4]).toMatchObject({status: 200, body: {risk: {by: 'owner'}}})
        expect(outcomes[5]).toMatchObject({status: 409})
        expect(outcomes[6]).toMatchObject({status: 200, body: {risk: null}})
        for (const at of [7, 8, 9, 10]) expect(outcomes[at], String(at)).toMatchObject({status: 400})
        for (const at of [11, 12, 13]) expect(outcomes[at], String(at)).toMatchObject({status: 404})
        expect(domainOf('PUT', '/api/projects/p/issues/P-1/pulls/ada/box/41/risk')).toBe("a pull request's risk")
        expect(domainOf('GET', '/api/projects/p/issues/P-1/pulls/ada/box/41/risk')).toBeUndefined()
        for (const [method, path] of [['GET', '/api/pulls'], ['GET', '/api/pulls/branches'], ['POST', '/api/pulls/poll'], ['DELETE', '/api/pulls/branches']])
            expect(servedByApi(method!, path!), `${method} ${path}`).toBe(false)
    })

    it('reads and changes the settings alike, every one, and refuses a session (ORR-954)', async () => {
        // The settings are the orrery's, so each side runs every step in turn on the same table, put back between them.
        type Step = [string, () => Promise<Outcome>, () => Promise<Outcome>]
        const step = (name: string, body: unknown, actor: Actor = OWNER): Step =>
            // The store tells a project sharing releases a moment later: settled first, so it lands in this step.
            [name, () => viaStore(async () => {
                try {
                    return await store.updateSettings(body, actor)
                } finally {
                    await new Promise(settled => setTimeout(settled, 20))
                }
            }), () => viaApi('PATCH', '/api/settings', body, actor)]
        const read: Step = ['the settings', () => viaStore(() => store.settings()), () => viaApi('GET', '/api/settings')]
        const steps: Step[] = [
            read,
            step('changed by a session', {tint: 'blue'}, SESSION),
            step('a tint, prompts and a handle', {tint: '#AABBCC', focus_prompt: '  Work on {id}  ', milestone_prompt: '   ', handle: 'Steffen.D'}),
            step('the machine\'s own', {terminal: 'ghostty', advanced: false, restrict_proposals: false, count_use: true}),
            step('instructions, a tracker and the sidebar', {instructions: [{id: 'a1', text: ' Be brief ', on: false}, {id: 'b2', text: 'Test first'}], tracker: 'https://t.example/i/{id}', starred: [' api ', 'web', 'api', 'gone'], hidden: ['gone']}),
            step('starts', {starts: {limit: 3, min: 1, minutes: 60, idle_minutes: 30, on_signal: false}}),
            step('work kinds', {work_kinds: [{id: 'bug', name: ' Bug ', labels: ['Bug', 'bug', 'defect'], model: 'claude-opus-5-5', effort: 'high'}, {id: 'other', name: 'Other', labels: [], model: 'best'}]}),
            read,
            step('everything wrong at once', {bogus: 1, tint: 'pink', terminal: 'xterm', handle: '-x', tracker: 'https://t.example/i', advanced: 'yes', count_use: null, starred: [''], instructions: [{text: ' '}], focus_prompt: 5}),
            step('starts out of range', {starts: {limit: 30}}),
            step('starts with more', {starts: {limit: 2, min: 3, extra: true}}),
            step('work kinds, none', {work_kinds: []}),
            step('work kinds, a label twice', {work_kinds: [{id: 'a', name: 'A', labels: ['x'], model: 'best'}, {id: 'b', name: 'B', labels: ['X'], model: 'best'}]}),
            step('work kinds, a bad model', {work_kinds: [{id: 'a', name: 'A', labels: [], model: 'gpt'}]}),
            step('work kinds, an id twice', {work_kinds: [{id: 'a', name: 'A', labels: [], model: 'best'}, {id: 'a', name: 'B', labels: [], model: 'best'}]}),
            step('no body', undefined),
            step('back to the defaults', {tint: null, focus_prompt: null, handle: null, tracker: null, starts: null, terminal: null, work_kinds: null, starred: null, hidden: null, instructions: null}),
            read,
        ]
        await store.settings()
        const before = await store.db.all<{key: string, value: string}>('SELECT key, value FROM settings')
        const putBack = async () => {
            await store.db.run('DELETE FROM settings')
            for (const {key, value} of before) await store.db.run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value)
        }
        const run = async (side: (step: Step) => Promise<Outcome>) => {
            const outcomes: Outcome[] = []
            for (const one of steps) outcomes.push(await side(one))
            await putBack()
            return outcomes
        }
        const viaTs = await run(([, ts]) => ts())
        const viaRs = await run(([, , rs]) => rs())
        // Every project changed both ways when `starts` did: the two names are the same here.
        const projects = (outcome: Outcome) => ({...outcome, changed: outcome.changed.map(() => '<a project>')})
        steps.forEach(([name], i) => expect(same(projects(viaRs[i]!), 'through-api'), name).toEqual(same(projects(viaTs[i]!), 'through-store')))
        expect(viaRs[5]).toMatchObject({status: 200, settings: true})
        expect(viaRs[5]!.changed).toEqual(expect.arrayContaining(['through-api', 'through-store']))
        expect(viaRs[2]).toMatchObject({settings: true, changed: []})
    })

    it('says which settings a change sent, for the event log (ORR-954)', async () => {
        const response = await fetch(`${url}/api/settings`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json', 'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...actorHeaders(OWNER)},
            body: JSON.stringify({tint: null, advanced: true}),
        })
        expect(response.status).toBe(200)
        expect(changedOf(response.headers.get('orrery-settings-keys'))).toEqual(['advanced', 'tint'])
        expect(domainOf('GET', '/api/settings')).toBe('settings')
        expect(domainOf('PATCH', '/api/settings/')).toBe('settings')
        expect(domainOf('GET', '/api/machine')).toBeUndefined()
    })

    it('lists, makes, changes, resets, restores and removes presets alike (ORR-949)', async () => {
        // Presets are the orrery's, or a project's, in one table, so each side runs every step in turn, the table put
        // back as it was between them. Ids are looked up by name at each step, and taken out of messages, as the two
        // sides' new ones differ on Postgres.
        type Step = [string, (project: string) => Promise<Outcome>, () => Promise<Outcome>]
        await store.seedPresets()
        const uid = (await store.settings()).uid
        const idOf = async (name: string) => (await store.presets('through-api')).concat(await store.presets('through-store')).find(p => p.name === name)?.id ?? 0
        const withoutIds = async (outcome: Promise<Outcome>) => {
            const ids = (await store.presets('through-api')).concat(await store.presets('through-store')).map(p => p.id)
            return JSON.parse(JSON.stringify(await outcome, (_key, value: unknown) => typeof value === 'string'
                ? ids.reduce((text, id) => text.replaceAll(`preset ${id}`, 'preset <id>'), value) : value)) as Outcome
        }
        const ship = {name: ' Ship it ', text: ' Go. ', icon: 'rocket-launch', color: 'violet'}
        const steps: Step[] = [
            ['the presets', () => viaStore(() => store.presets()), () => viaApi('GET', '/api/presets')],
            ['a project\'s', p => viaStore(() => store.presets(p)), () => viaApi('GET', '/presets')],
            ['a project that isn\'t there', () => viaStore(() => store.presets('nowhere')), () => viaApi('GET', '/presets', undefined, AGENT, 'nowhere')],
            ['made by a session', () => viaStore(() => store.createPreset(null, ship, SESSION)), () => viaApi('POST', '/api/presets', ship, SESSION)],
            ['made', () => viaStore(() => store.createPreset(null, ship, OWNER), 201), () => viaApi('POST', '/api/presets', ship, OWNER)],
            ['a project\'s own', p => viaStore(() => store.createPreset(p, {name: 'Local', text: 'Here.', color: '#AABBCC'}, OWNER), 201),
                () => viaApi('POST', '/presets', {name: 'Local', text: 'Here.', color: '#AABBCC'}, OWNER)],
            ['for a project that isn\'t there', () => viaStore(() => store.createPreset('nowhere', ship, OWNER)), () => viaApi('POST', '/presets', ship, OWNER, 'nowhere')],
            ['several problems', () => viaStore(() => store.createPreset(null, {bogus: 1, name: null, icon: 'Bad Icon', color: 'pink'}, OWNER)),
                () => viaApi('POST', '/api/presets', {bogus: 1, name: null, icon: 'Bad Icon', color: 'pink'}, OWNER)],
            ['no text', () => viaStore(() => store.createPreset(null, {name: 'X'}, OWNER)), () => viaApi('POST', '/api/presets', {name: 'X'}, OWNER)],
            ['a blank name', () => viaStore(() => store.createPreset(null, {name: '  ', text: 'x'}, OWNER)), () => viaApi('POST', '/api/presets', {name: '  ', text: 'x'}, OWNER)],
            ['no body', () => viaStore(() => store.createPreset(null, undefined, OWNER)), () => viaApi('POST', '/api/presets', undefined, OWNER)],
            ['a project\'s after', p => viaStore(() => store.presets(p)), () => viaApi('GET', '/presets')],
            ['renamed, its icon taken off', async () => viaStore(async () => store.updatePreset(await idOf('Ship it'), {name: ' Ship it now ', icon: null}, OWNER)),
                async () => viaApi('PATCH', `/api/presets/${await idOf('Ship it')}`, {name: ' Ship it now ', icon: null}, OWNER)],
            ['by its full id', async () => viaStore(async () => store.updatePreset(await idOf('Ship it now'), {text: 'Go now.'}, OWNER)),
                async () => viaApi('PATCH', `/api/presets/pst-${await idOf('Ship it now')}-${uid}`, {text: 'Go now.'}, OWNER)],
            ['changed by a session', async () => viaStore(async () => store.updatePreset(await idOf('Ship it now'), {text: 'x'}, SESSION)),
                async () => viaApi('PATCH', `/api/presets/${await idOf('Ship it now')}`, {text: 'x'}, SESSION)],
            ['a blank text', async () => viaStore(async () => store.updatePreset(await idOf('Ship it now'), {text: ' '}, OWNER)),
                async () => viaApi('PATCH', `/api/presets/${await idOf('Ship it now')}`, {text: ' '}, OWNER)],
            ['one that isn\'t there', () => viaStore(() => store.updatePreset(99_999_999, {name: 'X'}, OWNER)), () => viaApi('PATCH', '/api/presets/99999999', {name: 'X'}, OWNER)],
            ['one orrery ships, changed', async () => viaStore(async () => store.updatePreset(await idOf('Release'), {text: 'Changed.'}, OWNER)),
                async () => viaApi('PATCH', `/api/presets/${await idOf('Release')}`, {text: 'Changed.'}, OWNER)],
            ['reset', async () => viaStore(async () => store.resetPreset(await idOf('Release'), OWNER)), async () => viaApi('POST', `/api/presets/${await idOf('Release')}/reset`, undefined, OWNER)],
            ['reset by a session', async () => viaStore(async () => store.resetPreset(await idOf('Release'), SESSION)), async () => viaApi('POST', `/api/presets/${await idOf('Release')}/reset`, undefined, SESSION)],
            ['one it doesn\'t ship, reset', async () => withoutIds(viaStore(async () => store.resetPreset(await idOf('Ship it now'), OWNER))),
                async () => withoutIds(viaApi('POST', `/api/presets/${await idOf('Ship it now')}/reset`, undefined, OWNER))],
            ['removed by a session', async () => viaStore(async () => store.deletePreset(await idOf('Release'), SESSION)), async () => viaApi('DELETE', `/api/presets/${await idOf('Release')}`, undefined, SESSION)],
            ['one it ships, removed', async () => viaStore(async () => store.deletePreset(await idOf('Release'), OWNER)), async () => viaApi('DELETE', `/api/presets/${await idOf('Release')}`, undefined, OWNER)],
            ['one that isn\'t there, removed', () => viaStore(() => store.deletePreset(99_999_999, OWNER)), () => viaApi('DELETE', '/api/presets/99999999', undefined, OWNER)],
            ['restored by a session', () => viaStore(() => store.restorePresets(SESSION)), () => viaApi('POST', '/api/presets/defaults', undefined, SESSION)],
            ['the removed one restored', () => viaStore(() => store.restorePresets(OWNER)), () => viaApi('POST', '/api/presets/defaults', undefined, OWNER)],
            ['none left to restore', () => viaStore(() => store.restorePresets(OWNER)), () => viaApi('POST', '/api/presets/defaults', undefined, OWNER)],
            ['a project\'s at the end', p => viaStore(() => store.presets(p)), () => viaApi('GET', '/presets')],
        ]
        type Row = Record<string, unknown>
        const before = await store.db.all<Row>('SELECT * FROM presets ORDER BY id')
        const putBack = async () => {
            await store.db.run('DELETE FROM presets')
            for (const row of before) {
                const columns = Object.keys(row)
                await store.db.run(`INSERT INTO presets (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map(c => row[c] as string | number | null))
            }
        }
        const run = async (side: (step: Step) => Promise<Outcome>) => {
            const outcomes: Outcome[] = []
            for (const step of steps) outcomes.push(await side(step))
            await putBack()
            return outcomes
        }
        const viaTs = await run(([, ts]) => ts('through-store'))
        const viaRs = await run(([, , rs]) => rs())
        steps.forEach(([name], i) => expect(same(viaRs[i]!, 'through-api'), name).toEqual(same(viaTs[i]!, 'through-store')))
        // The steps compared something: what the API made and changed is there.
        expect(viaRs[4]).toMatchObject({status: 201, body: {name: 'Ship it', text: 'Go.', icon: 'rocket-launch', project: null}})
        expect(viaRs[17]).toMatchObject({body: {default: {key: 'release', changed: true}}})
        expect(viaRs[18]).toMatchObject({body: {default: {key: 'release', changed: false}}})
        expect(viaRs[25]).toMatchObject({status: 200, body: [{name: 'Release', default: {key: 'release', changed: false}}]})
        // Not a number: the route's `presetId` refuses it before the store is asked.
        expect((await viaApi('PATCH', '/api/presets/abc', {name: 'X'}, OWNER)).body).toEqual({message: 'No preset abc'})
    })

    it('reads, clears and marks the bell read alike, each person their own (ORR-1005)', async () => {
        // The bell is the orrery's, so both sides read the same rows: a question on each project, one answered, a
        // proposal, a status change, and a comment by Ada's agent, on top of what the steps before left.
        const ADAS: Actor = {name: 'agent', owner: false, named: 'ada', asked: true}
        const since = new Date(Date.now() - 1000).toISOString()
        const asked: Record<string, string> = {}
        for (const p of ['through-store', 'through-api']) {
            const {id} = await store.createIssue(p, {title: 'Which hinge?'}, SESSION)
            asked[p] = id
            await store.createComment(p, id, {body: 'Brass or steel?', asks: 'decision'}, SESSION)
            await store.createComment(p, id, {body: 'Done the frame.'}, SESSION)
            const {id: oil} = await store.createIssue(p, {title: 'Oil it?'}, SESSION)
            await store.createComment(p, oil, {body: 'Oil?', asks: 'feedback'}, SESSION)
            await store.createComment(p, oil, {body: 'Yes'}, OWNER)
            await store.updateIssue(p, oil, {status: 'done'}, OWNER)
            await store.createIssue(p, {title: 'Add a gear', proposal: 'pending'}, SESSION)
            await store.createComment(p, id, {body: 'Ada, the hinge is yours.'}, ADAS)
        }
        const latest = (await store.notices({list: 'inbox'}))
        const older = latest[2]!.id
        // Whose bell each asker gets: the route works it out (`personOf`), the API from the headers.
        const askers: [string, Actor, string | undefined][] = [
            ['the owner', OWNER, 'steffen'],
            ['a session naming Ada', ADAS, await store.personFor('ada')],
            ['Ada herself', {name: 'ada', owner: false, person: 'ada', asked: true}, 'ada'],
            ['an untrusted session', {name: 'agent', owner: false, untrusted: true, asked: true}, undefined],
        ]
        for (const [who, actor, person] of askers) {
            const reads: [string, Parameters<Store['notices']>[0], string][] = [
                ['the bell', {}, ''],
                ['waiting', {list: 'waiting'}, '?list=waiting'],
                ['the inbox', {list: 'inbox'}, '?list=inbox'],
                ['a page of the inbox', {list: 'inbox', limit: 2, before: older}, `?list=inbox&limit=2&before=${older}`],
                ['too big a page', {list: 'inbox', limit: 200}, '?list=inbox&limit=900'],
                ['cleared', {list: 'cleared'}, '?list=cleared'],
                ['an unknown list', {list: 'later' as never}, '?list=later'],
            ]
            for (const [name, query, path] of reads) {
                await alike0(`${who}: ${name}`, () => viaStore(() => store.notices({...query, limit: query?.limit, person})), () => viaApi('GET', `/api/notices${path}`, undefined, actor))
            }
            await alike0(`${who}: the changes`, () => viaStore(() => store.noticeChanges({since, person})), () => viaApi('GET', `/api/notices/changes?since=${encodeURIComponent(since)}`, undefined, actor))
            await alike0(`${who}: changes since no time`, () => viaStore(() => store.noticeChanges({since: 'soon', person})), () => viaApi('GET', '/api/notices/changes?since=soon', undefined, actor))
        }
        expect((await viaApi('GET', '/api/notices/changes?since=' + encodeURIComponent(since), undefined, OWNER)).body).toEqual(expect.arrayContaining([expect.objectContaining({after: 'done'})]))

        // The writes change the same rows, so each side runs them all in turn, put back as they were between them.
        const ADA: Actor = {name: 'ada', owner: false, person: 'ada', asked: true}
        const question = (await store.notices({list: 'waiting'})).find(n => n.body === 'Brass or steel?' && n.project === 'through-store')!.id
        const told = (await store.notices({list: 'inbox'})).find(n => n.body === 'Done the frame.' && n.project === 'through-api')!.id
        const adas = (await store.notices({person: 'ada'})).map(n => n.id)
        // Ada's bell is her own: her agent's words, not the owner's questions.
        expect((await viaApi('GET', '/api/notices', undefined, ADA)).body).toEqual(expect.arrayContaining([expect.objectContaining({body: 'Ada, the hinge is yours.'})]))
        expect((await viaApi('GET', '/api/notices', undefined, ADA)).body).not.toEqual(expect.arrayContaining([expect.objectContaining({body: 'Brass or steel?'})]))
        const gear = (await store.notices({list: 'waiting'})).find(n => n.title === 'Add a gear' && n.project === 'through-api')!
        type Step = [string, () => Promise<Outcome>, () => Promise<Outcome>]
        const write = (name: string, route: 'clear' | 'read', body: unknown, actor: Actor = OWNER): Step => {
            const person = actor.person
            const ts = () => viaStore(async () => {
                if (!person && !actor.owner) throw refused(permission('notices.clear'), actor.untrusted ? 'untrusted' : actor.chat ? 'chat' : 'session')
                return route === 'clear' ? {cleared: await store.clearNotices(body, person)} : {read: await store.readNotices(body, person)}
            })
            return [name, ts, () => viaApi('POST', `/api/notices/${route}`, body, actor)]
        }
        const look = (name: string, actor: Actor = OWNER, list?: 'cleared'): Step => [name,
            () => viaStore(() => store.notices({list, person: actor.person ?? 'steffen'})), () => viaApi('GET', `/api/notices${list ? `?list=${list}` : ''}`, undefined, actor)]
        const steps: Step[] = [
            write('read by the owner', 'read', {ids: [told, question]}),
            write('read again', 'read', {ids: [told]}),
            write('read by Ada', 'read', {ids: adas}, ADA),
            write('read with no ids', 'read', {ids: []}),
            write('read with a fraction', 'read', {ids: [1.5]}),
            write('read with no body', 'read', undefined),
            look('the owner\'s bell, read'),
            look('Ada\'s bell, read', ADA),
            write('cleared by a session', 'clear', {ids: [told]}, SESSION),
            write('read by the chat', 'read', {ids: [told]}, {name: 'steffen', owner: false, chat: true}),
            write('cleared by id and a proposal', 'clear', {ids: [told], proposals: [{project: gear.project, issue: gear.issue}, {project: 'through-api', issue: 'nope'}]}),
            write('null ids with a proposal', 'clear', {ids: null, proposals: [{project: gear.project, issue: gear.issue}]}),
            write('a proposal that isn\'t one', 'clear', {proposals: [{project: 1}]}),
            look('cleared', OWNER, 'cleared'),
            write('everything read', 'clear', {read: true}),
            write('everything up to now', 'clear', {before: new Date(Date.now() + 60_000).toISOString()}),
            look('the owner\'s bell, cleared'),
            write('Ada\'s by id', 'clear', {ids: adas.slice(0, 1)}, ADA),
            write('Ada\'s read', 'clear', {read: true}, ADA),
            write('Ada\'s up to now', 'clear', {before: new Date(Date.now() + 60_000).toISOString()}, ADA),
            write('Ada\'s proposals, which she has none of', 'clear', {proposals: [{project: gear.project, issue: gear.issue}]}, ADA),
            look('Ada\'s cleared', ADA, 'cleared'),
            write('nothing to clear', 'clear', {}),
            write('no body to clear', 'clear', undefined),
        ]
        const tables = ['notice_clears', 'notice_reads', 'proposal_clears']
        const before = {
            comments: await store.db.all<{id: number, cleared: number, was_read: number}>('SELECT id, cleared, was_read FROM comments'),
            ...Object.fromEntries(await Promise.all(tables.map(async t => [t, await store.db.all<Record<string, unknown>>(`SELECT * FROM ${t}`)]))),
        } as Record<string, Record<string, unknown>[]>
        const putBack = async () => {
            for (const c of before.comments!) await store.db.run('UPDATE comments SET cleared = ?, was_read = ? WHERE id = ?', c.cleared, c.was_read, c.id)
            for (const t of tables) {
                await store.db.run(`DELETE FROM ${t}`)
                for (const row of before[t]!) await store.db.run(`INSERT INTO ${t} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, ...Object.values(row) as never[])
            }
        }
        const run = async (side: (step: Step) => Promise<Outcome>) => {
            const outcomes: Outcome[] = []
            for (const one of steps) outcomes.push(await side(one))
            await putBack()
            return outcomes
        }
        const viaTs = await run(([, ts]) => ts())
        const viaRs = await run(([, , rs]) => rs())
        steps.forEach(([name], i) => expect(viaRs[i], name).toEqual(viaTs[i]))
        expect(viaRs[0]!.body).toEqual({read: 2})
        expect(viaRs[8]).toMatchObject({status: 403})
        expect((viaRs[10]!.body as {cleared: number}).cleared).toBe(2)
    })

    it('comments on a milestone and on an epic alike, the owner\'s words theirs (ORR-1004)', async () => {
        const milestones: Record<string, string> = {}
        const epics: Record<string, number> = {}
        for (const p of ['through-store', 'through-api']) {
            milestones[p] = (await store.createMilestone(p, {title: 'Oil the joints'})).id
            epics[p] = (await store.createEpic({title: `Comments through ${p}`})).id
        }
        // What a thread's step gave, either side: its comments' ids in order, and the epic's number, aren't compared.
        const alike = (outcome: Outcome, p: string) => JSON.parse(JSON.stringify(same(outcome, p), (key, value: unknown) => key === 'epic' ? '<epic>' : typeof value === 'string' ? value.replace(/comment \d+/g, 'comment <n>').replace(/epic \d+/g, 'epic <n>') : value)) as unknown
        const ids: Record<string, number[]> = {'through-store': [], 'through-api': []}
        const kept = (p: string, outcome: Outcome) => {
            const id = (outcome.body as {id?: number} | null)?.id
            if (outcome.status === 201 && id) ids[p]!.push(id)
            return outcome
        }
        for (const kind of ['milestone', 'epic'] as const) {
            ids['through-store'] = []
            ids['through-api'] = []
            const path = (p: string) => kind === 'milestone' ? `/api/projects/${p}/milestones/${milestones[p]}/comments` : `/api/epics/${epics[p]}/comments`
            const store_ = {
                list: (p: string) => kind === 'milestone' ? store.listMilestoneComments(p, milestones[p]!) : store.listEpicComments(epics[p]!),
                add: (p: string, body: unknown, actor: Actor) => kind === 'milestone' ? store.createMilestoneComment(p, milestones[p]!, body, actor) : store.createEpicComment(epics[p]!, body, actor),
                edit: (p: string, id: number, body: unknown, actor: Actor) => kind === 'milestone' ? store.updateMilestoneComment(p, milestones[p]!, id, body, actor) : store.updateEpicComment(epics[p]!, id, body, actor),
                remove: (p: string, id: number, actor: Actor) => kind === 'milestone' ? store.deleteMilestoneComment(p, milestones[p]!, id, actor) : store.deleteEpicComment(epics[p]!, id, actor),
            }
            const step = async (name: string, ts: (p: string) => Promise<Outcome>, rs: (p: string) => Promise<Outcome>) => {
                const [a, b] = [kept('through-store', await ts('through-store')), kept('through-api', await rs('through-api'))]
                expect(alike(b, 'through-api'), `${kind}: ${name}`).toEqual(alike(a, 'through-store'))
                return b
            }
            const nth = (p: string, n: number) => ids[p]![n]!
            await step('none yet', p => viaStore(() => store_.list(p)), p => viaApi('GET', path(p)))
            const first = await step('a session\'s', p => viaStore(() => store_.add(p, {body: 'Oiled the hinge'}, SESSION), 201), p => viaApi('POST', path(p), {body: 'Oiled the hinge'}, SESSION))
            await step('the owner\'s', p => viaStore(() => store_.add(p, {body: 'Good'}, OWNER), 201), p => viaApi('POST', path(p), {body: 'Good'}, OWNER))
            await step('a blank one', p => viaStore(() => store_.add(p, {body: ' '}, SESSION)), p => viaApi('POST', path(p), {body: ' '}, SESSION))
            await step('no words, and asking', p => viaStore(() => store_.add(p, {asks: 'decision'}, SESSION)), p => viaApi('POST', path(p), {asks: 'decision'}, SESSION))
            await step('no body', p => viaStore(() => store_.add(p, undefined, SESSION)), p => viaApi('POST', path(p), undefined, SESSION))
            await step('the thread', p => viaStore(() => store_.list(p)), p => viaApi('GET', path(p)))
            await step('edited by its session', p => viaStore(() => store_.edit(p, nth(p, 0), {body: 'Oiled twice'}, SESSION)), p => viaApi('PATCH', `${path(p)}/${nth(p, 0)}`, {body: 'Oiled twice'}, SESSION))
            await step('the owner\'s, edited by a session', p => viaStore(() => store_.edit(p, nth(p, 1), {body: 'Bad'}, SESSION)), p => viaApi('PATCH', `${path(p)}/${nth(p, 1)}`, {body: 'Bad'}, SESSION))
            await step('edited with nothing', p => viaStore(() => store_.edit(p, nth(p, 1), {}, OWNER)), p => viaApi('PATCH', `${path(p)}/${nth(p, 1)}`, {}, OWNER))
            await step('one that isn\'t there', p => viaStore(() => store_.edit(p, 99_999_999, {body: 'X'}, OWNER)), p => viaApi('PATCH', `${path(p)}/99999999`, {body: 'X'}, OWNER))
            await step('the owner\'s, deleted by a session', p => viaStore(() => store_.remove(p, nth(p, 1), SESSION)), p => viaApi('DELETE', `${path(p)}/${nth(p, 1)}`, undefined, SESSION))
            await step('a session\'s, deleted', p => viaStore(() => store_.remove(p, nth(p, 0), SESSION)), p => viaApi('DELETE', `${path(p)}/${nth(p, 0)}`, undefined, SESSION))
            await step('the thread after', p => viaStore(() => store_.list(p)), p => viaApi('GET', path(p)))
            expect(first.status).toBe(201)
            expect(first.changed, kind).toEqual(kind === 'milestone' ? await sharing(['through-api']) : [])
        }
        // What isn't there, on each kind's own path.
        const missing = (name: string, ts: () => Promise<unknown>, rs: string) => alike0(name, () => viaStore(ts), () => viaApi('GET', rs))
        await missing('a milestone that isn\'t there', () => store.listMilestoneComments('through-api', '99999'), '/api/projects/through-api/milestones/99999/comments')
        await missing('an epic that isn\'t there', () => store.listEpicComments(99_999), '/api/epics/99999/comments')
    })

    it('lists, reads, makes, changes, moves and deletes epics alike, telling what each did (ORR-1004)', async () => {
        // The epics are the orrery's, so each side runs every step in turn on the same tables, put back between them,
        // their numbering too, so both make the same epics. Each project has a cog with a tooth to put in them.
        const cogs: Record<string, {cog: string, tooth: string}> = {}
        for (const p of ['through-store', 'through-api']) {
            const {id: cog} = await store.createIssue(p, {title: 'Cut a cog'}, SESSION)
            const {id: tooth} = await store.createIssue(p, {title: 'File a tooth', parent: cog}, SESSION)
            cogs[p] = {cog, tooth}
        }
        const top = Number((await store.db.get<{n: number | null}>('SELECT max(id) AS n FROM epics'))?.n ?? 0)
        const [gears, springs] = [top + 1, top + 2]
        const {uid} = await store.settings()
        // As the route reads the URL (`epicId`), then the store.
        const epicOf = (sent: string) => {
            const number = sent ? numberOf('epic', sent, uid) : null
            const id = Number(number)
            if (number === null || !Number.isInteger(id)) throw Object.assign(new Error(`No epic ${sent}: GET /api/epics lists them`), {statusCode: 404})
            return id
        }
        const into = async (): Promise<Outcome> => {
            for (const p of Object.keys(cogs)) {
                await store.db.run('UPDATE issues SET epic = ? WHERE project = ? AND id = ?', gears, p, cogs[p]!.cog)
                await store.db.run('UPDATE issues SET epic = ? WHERE project = ? AND id = ?', springs, p, cogs[p]!.tooth)
            }
            return {status: 200, body: null, changed: [], told: [], settings: false}
        }
        type Step = [string, () => Promise<Outcome>, () => Promise<Outcome>]
        const read = (name: string, sent?: string): Step => [name,
            () => viaStore(async () => sent === undefined ? store.epics() : store.epic(epicOf(sent))), () => viaApi('GET', sent === undefined ? '/api/epics' : `/api/epics/${encodeURIComponent(sent)}`)]
        const make = (name: string, body: unknown, actor: Actor = SESSION): Step => [name, () => viaStore(() => store.createEpic(body, actor), 201), () => viaApi('POST', '/api/epics', body, actor)]
        const change = (name: string, sent: string, body: unknown, actor: Actor = SESSION): Step => [name,
            () => viaStore(async () => store.updateEpic(epicOf(sent), body, actor)), () => viaApi('PATCH', `/api/epics/${sent}`, body, actor)]
        const remove = (name: string, sent: string, actor: Actor = SESSION): Step => [name,
            () => viaStore(async () => store.deleteEpic(epicOf(sent), actor)), () => viaApi('DELETE', `/api/epics/${sent}`, undefined, actor)]
        const steps: Step[] = [
            read('the epics'),
            make('made by the owner', {title: ' Gears ', notes: 'Of brass'}, OWNER),
            make('made by a session, on top', {title: 'Springs', position: 0}),
            make('a blank title', {title: ' '}),
            make('an unknown field and a bad place', {title: 'X', bogus: 1, position: 'a'}),
            make('no body', undefined),
            ['issues put in them', into, into],
            read('the epics with their issues'),
            read('one by number', String(gears)),
            read('one as shown', `EPC-${springs}`),
            read('one by its full id', `EPC-${springs}-${uid}`),
            read('one that isn\'t there', 'EPC-99999'),
            read('one that isn\'t a number', 'nope'),
            change('retitled', String(gears), {title: ' Gears and cogs '}),
            change('the same title', String(gears), {title: 'Gears and cogs'}),
            change('moved only', String(gears), {position: 5}),
            change('its notes taken away', String(gears), {notes: null}),
            change('a null title', String(gears), {title: null}),
            change('one that isn\'t there', '99999', {title: 'X'}),
            remove('the owner\'s, by a session', String(gears)),
            remove('a session\'s, by a session', `EPC-${springs}`),
            read('the epics after'),
            remove('the owner\'s, by the owner', String(gears), OWNER),
            remove('one that\'s gone', String(gears), OWNER),
            read('none left of them'),
        ]
        const before = await store.db.all<Record<string, unknown>>('SELECT * FROM epics ORDER BY id')
        const inEpics = await store.db.all<{project: string, id: string, epic: number}>('SELECT project, id, epic FROM issues WHERE epic IS NOT NULL')
        const putBack = async () => {
            await store.db.run('UPDATE issues SET epic = NULL WHERE epic IS NOT NULL')
            await store.db.run('DELETE FROM epics')
            for (const row of before) await store.db.run(`INSERT INTO epics (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, ...Object.values(row) as never[])
            for (const {project, id, epic} of inEpics) await store.db.run('UPDATE issues SET epic = ? WHERE project = ? AND id = ?', epic, project, id)
            if (store.db instanceof PostgresDb) await store.db.get(`SELECT setval(pg_get_serial_sequence('epics', 'id'), ${top || 1}, ${top > 0})`)
            else await store.db.run("UPDATE sqlite_sequence SET seq = ? WHERE name = 'epics'", top)
        }
        const run = async (side: (step: Step) => Promise<Outcome>) => {
            const outcomes: Outcome[] = []
            for (const one of steps) outcomes.push(await side(one))
            await putBack()
            return outcomes
        }
        const epicsRows = async () => Number((await store.db.get<{n: number}>("SELECT count(*) AS n FROM changes WHERE kind = 'epics'"))!.n)
        const first = await epicsRows()
        const viaTs = await run(([, ts]) => ts())
        const said = await epicsRows()
        const viaRs = await run(([, , rs]) => rs())
        const times = (outcome: Outcome) => JSON.parse(JSON.stringify(outcome, (_, value: unknown) => typeof value === 'string' ? value.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '<time>') : value)) as unknown
        steps.forEach(([name], i) => expect(times(viaRs[i]!), name).toEqual(times(viaTs[i]!)))
        // Both say the epics changed on each write, in the outbox: the store's own rows, then the API's.
        expect(said - first).toBeGreaterThan(0)
        expect(await epicsRows() - said).toBe(said - first)
        expect(viaRs[1]).toMatchObject({status: 201, body: {id: gears, title: 'Gears', notes: 'Of brass', protected: true, parts: []}})
        expect((viaRs[7]!.body as {id: number, issues: number, projects: unknown[]}[]).find(e => e.id === springs)).toMatchObject({issues: 2, projects: [{project: 'through-api', issues: 1}, {project: 'through-store', issues: 1}]})
        expect(viaRs[13]!.told).toEqual(['epic.changed ' + gears, 'epic.changed ' + gears])
        expect(viaRs[15]!.told).toEqual([])
        expect(viaRs[19]).toMatchObject({status: 403})
        expect(viaRs[20]).toMatchObject({status: 204, told: [`issue.epic ${cogs['through-api']!.tooth}`, `issue.epic ${cogs['through-store']!.tooth}`]})
    })

    it('keeps what each write set off in the outbox, in order, to read after an id (ORR-929)', async () => {
        const read = async (after?: number) => (await viaApi('GET', `/api/changes${after === undefined ? '' : `?after=${after}`}`)).body as {changes: {id: number, kind: string, project?: string, subject?: string, actor?: string, owner: boolean, session?: string}[], last: number}
        const last = await newestChange()
        expect((await viaApi('POST', '/docs', {title: 'Outbox'}, SESSION)).status).toBe(201)
        const after = await read(last)
        expect(after.changes.map(({kind, project, subject, actor, owner, session}) => ({kind, project, subject, actor, owner, session}))).toEqual([
            {kind: 'project.changed', project: 'through-api', subject: undefined, actor: 'agent', owner: false, session: 'orrery · Njord'},
            {kind: 'doc.created', project: 'through-api', subject: 'outbox', actor: 'agent', owner: false, session: 'orrery · Njord'},
        ])
        expect(after.last).toBe(after.changes.at(-1)!.id)
        expect(await read(after.last)).toEqual({changes: [], last: after.last})
        // A read changes nothing, and a refused write sets nothing off.
        await viaApi('GET', '/docs')
        await viaApi('POST', '/docs', {title: ' '})
        expect((await read(after.last)).changes).toEqual([])
        expect(await viaApi('GET', '/api/changes?after=x')).toMatchObject({status: 400})
    })

    it("is followed by the local app, which tells its hooks what the API's writes set off (ORR-983)", async () => {
        const last = await newestChange()
        const [before, told] = [changes.length, events.length]
        expect((await viaApi('POST', '/docs', {title: 'Followed'}, SESSION)).status).toBe(201)
        let reads = 0
        let cursor = last
        await followOutbox(store, {
            read: from => (reads++, readPage({url, token: TOKEN}, databaseMark(setting), from)),
            after: last,
            saved: at => cursor = at,
            stopped: () => reads >= 2,
            every: 1,
        })
        expect(changes.slice(before)).toContain('through-api')
        expect(events.slice(told).map(e => `${e.type} ${e.project} ${e.subject} ${e.by.name}`)).toEqual(['doc.created through-api followed agent'])
        expect(cursor).toBe(await newestChange())
    })

    it('streams the outbox as server-sent events, live, and says when a cursor has gone (ORR-929)', async () => {
        const headers = {'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...actorHeaders(SESSION)}
        // The newest id, so the stream opens after every row there is.
        const last = await newestChange()
        const stop = new AbortController()
        const response = await fetch(`${url}/api/changes?after=${last}`, {headers: {...headers, Accept: 'text/event-stream'}, signal: stop.signal})
        expect(response.headers.get('content-type')).toContain('text/event-stream')
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
        let said = ''
        const events = async (count: number) => {
            for (;;) {
                const found = said.split('\n\n').filter(e => /^data:/m.test(e))
                if (found.length >= count) return found.map(e => ({id: /^id:\s*(\d+)/m.exec(e)?.[1], event: /^event:\s*(\S+)/m.exec(e)?.[1], data: JSON.parse(/^data:\s*(.*)$/m.exec(e)![1]!)}))
                const {value, done} = await reader.read()
                if (done) throw new Error('the stream ended')
                said += value
            }
        }
        // Made after the stream opened, so it comes live, woken by the write rather than on its next look.
        expect((await viaApi('POST', '/docs', {title: 'Streamed'}, SESSION)).status).toBe(201)
        const started = Date.now()
        const sent = await events(2)
        expect(Date.now() - started).toBeLessThan(900)
        expect(sent.map(({data: {kind, subject}}) => ({kind, subject}))).toEqual([{kind: 'project.changed', subject: undefined}, {kind: 'doc.created', subject: 'streamed'}])
        expect(sent.map(e => Number(e.id))).toEqual(sent.map(e => e.data.id))
        stop.abort()
        // A cursor the outbox doesn't keep has missed rows: read the board again, and carry on from the newest.
        const newest = sent.at(-1)!.data.id as number
        expect((await viaApi('GET', `/api/changes?after=${newest + 1000}`)).body).toEqual({changes: [], last: newest, gap: true})
        const gone = await fetch(`${url}/api/changes`, {headers: {...headers, 'Accept': 'text/event-stream', 'Last-Event-ID': String(newest + 1000)}, signal: AbortSignal.timeout(5000)})
        const first = (await gone.body!.pipeThrough(new TextDecoderStream()).getReader().read()).value!
        expect(first).toMatch(/^event: gap$/m)
        expect(first).toContain(`data: {"last":${newest}}`)
        await gone.body?.cancel().catch(() => {})
        expect(await fetch(`${url}/api/changes?after=x`, {headers: {...headers, Accept: 'text/event-stream'}}).then(r => r.status)).toBe(400)
    })

    it('records a request that runs two transactions once (ORR-929)', async () => {
        const read = async (after: number) => ((await viaApi('GET', `/api/changes?after=${after}`)).body as {changes: {kind: string, project?: string}[]}).changes
        expect((await viaApi('POST', '/doc-sections', {name: 'Outbound'})).status).toBe(201)
        const made = await newestChange()
        // Renaming it and moving it are two transactions, but one project changed.
        expect((await viaApi('PATCH', '/doc-sections/Outbound', {name: 'Inbound', position: 0})).status).toBe(200)
        expect((await read(made)).map(({kind, project}) => ({kind, project}))).toEqual([{kind: 'project.changed', project: 'through-api'}])
        expect((await viaApi('DELETE', '/doc-sections/Inbound')).status).toBe(204)
    })

    it('answers only the server in front of it, on its own database', async () => {
        const ask = (headers: Record<string, string>) => fetch(`${url}/api/projects/through-api/docs`, {headers}).then(r => r.status)
        expect(await ask({})).toBe(401)
        expect(await ask({'Orrery-Api-Token': `${TOKEN}x`, 'Orrery-Database': databaseMark(setting)})).toBe(401)
        expect(await ask({'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark('/elsewhere.db')})).toBe(421)
        expect(await ask({'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting)})).toBe(200)
    })
})

describe('the router', () => {
    it("sends who's asking, with what the rails between people need (ORR-927)", () => {
        expect(actorHeaders({name: 'Ana Lu', owner: false, session: 'orrery · Ty', person: 'ana', named: 'Ana', asked: true})).toEqual({
            'Orrery-Actor-Name': 'Ana%20Lu', 'Orrery-Actor-Owner': '0', 'Orrery-Actor-Kind': 'session', 'Orrery-Actor-Session': 'orrery%20%C2%B7%20Ty',
            'Orrery-Actor-Person': 'ana', 'Orrery-Actor-Named': 'Ana', 'Orrery-Actor-Asked': '1',
        })
        expect(actorHeaders({name: 'steffen', owner: true})).toEqual({'Orrery-Actor-Name': 'steffen', 'Orrery-Actor-Owner': '1', 'Orrery-Actor-Kind': 'owner'})
    })

    it('sends the docs domain and the statuses to the API, and keeps an artifact\'s page and everything else here', () => {
        for (const path of ['/api/projects/p/docs', '/api/projects/p/docs/', '/api/projects/p/docs/d', '/api/projects/p/docs/d/revisions', '/api/projects/p/docs/d/revisions/3',
            '/api/projects/p/docs/d/revisions/3/restore', '/api/projects/p/deleted-docs', '/api/projects/p/doc-sections', '/api/projects/p/doc-sections/how it works']) expect(servedByApi('GET', path), path).toBe(true)
        for (const path of ['/api/projects/p/docs/d/artifact', '/api/projects/p', '/api/projects/p/docs/d/revisions/3/other', '/api/docs']) expect(servedByApi('GET', path), path).toBe(false)
        for (const path of ['/api/statuses', '/api/statuses/', '/api/statuses/in-review']) expect(servedByApi('GET', path), path).toBe(true)
        for (const path of ['/api/statuses/x/y', '/api/projects/p/statuses', '/api/machine']) expect(servedByApi('GET', path), path).toBe(false)
    })

    it('routes by a table with a line per domain, so taking one back is taking its line out (ORR-925)', () => {
        expect(DOMAINS.map(({domain}) => domain)).toEqual(['docs', 'statuses', 'issues, reading', 'comments', 'an issue, deleted', 'an issue, made', 'an issue, its words', 'issues, changed at once', 'a proposal, decided', 'claims', 'activity', 'milestones', 'releases', 'releases, every project\'s', 'people', 'invites', 'keys', 'logins', 'uploads, reading', 'presets', 'secrets, reading', 'settings', 'a pull request, reading', "a pull request's risk", 'schedules, reading', 'projects, listed', 'a project, made', 'a project, changed', 'a project, exported', 'a project, imported', 'the bell', 'epics', 'milestone and epic comments'])
        expect(domainOf('PATCH', '/api/projects/p/docs/d')).toBe('docs')
        expect(domainOf('head', '/api/projects/p/doc-sections/')).toBe('docs')
        for (const method of ['POST', 'DELETE']) expect(domainOf(method, '/api/projects/p/issues/P-1/claim'), method).toBe('claims')
        expect(domainOf('DELETE', '/api/projects/p/issues/P-1')).toBe('an issue, deleted')
        expect(domainOf('PATCH', '/api/projects/p/issues/P-1')).toBe('an issue, its words')
        expect(domainOf('POST', '/api/projects/p/issues/P-1')).toBeUndefined()
        // An issue's edit goes on only with nothing but its words: the rest of it stays here for now.
        expect(onlyWords({title: 'x', priority: 'P0', notes: null, labels: [], depends_on: ['P-2'], position: 2})).toBe(true)
        expect(urgentOf('my%20project P-1')).toEqual([{project: 'my project', issue: 'P-1'}])
        expect(urgentOf('p P-1, p%2Cq P-2')).toEqual([{project: 'p', issue: 'P-1'}, {project: 'p,q', issue: 'P-2'}])
        for (const header of [null, '', 'p', 'p P-1 x']) expect(urgentOf(header), String(header)).toEqual([])
        expect(onlyWords({parent: null, milestone: '3', release: '1.0.0'})).toBe(true)
        expect(onlyWords({proposal: 'pending', notes: 'Still wanted?'})).toBe(true)
        expect(onlyWords({epic: 'EPC-1', title: 'x', choices: []})).toBe(true)
        expect(onlyWords({title: 'x', status: 'todo', assignee: 'claude', plan: null})).toBe(true)
        for (const body of [{title: 'x', project: 'q'}, {project: 'q'}, {nope: 1}, {}, null, [], 'title']) expect(onlyWords(body), JSON.stringify(body)).toBe(false)
        // A session's change of status stays here, for its lock on the issue (`claimed`).
        for (const body of [{status: 'done'}, {plan: null, title: 'x'}]) expect(movesStatus(body), JSON.stringify(body)).toBe(true)
        for (const body of [{assignee: 'owner'}, {title: 'x'}, null, 'status']) expect(movesStatus(body), JSON.stringify(body)).toBe(false)
        expect(domainOf('DELETE', '/api/projects/p/issues')).toBe('an issue, deleted')
        for (const path of ['/api/projects/p/issues/P-1/activity/x', '/api/', '/docs', '/api/projects/p/docs/d/artifact']) expect(domainOf('GET', path), path).toBeUndefined()
    })

    it('sends only the methods a line names, so a domain\'s reads can move before its writes (ORR-927)', () => {
        expect(domainOf('GET', '/api/projects/p/issues/P-1/comments')).toBe('comments')
        expect(domainOf('HEAD', '/api/projects/p/issues/P-1/comments/3')).toBe('comments')
        expect(domainOf('POST', '/api/projects/p/issues/P-1/comments')).toBe('comments')
        expect(domainOf('DELETE', '/api/projects/p/issues/P-1/comments/3')).toBe('comments')
        expect(domainOf('PATCH', '/api/projects/p/issues/P-1/comments/3')).toBe('comments')
        for (const path of ['/api/projects/p/issues/P-1/comments/3/x', '/api/projects/p/issues/P-1/schedule-requests/3', '/api/projects/p/issues/P-1/branches']) expect(domainOf('GET', path), path).toBeUndefined()
        expect(domainOf('GET', '/api/projects/p/issues')).toBe('issues, reading')
        expect(domainOf('GET', '/api/projects/p/issues/P-1')).toBe('issues, reading')
        expect(domainOf('POST', '/api/projects/p/issues')).toBe('an issue, made')
        expect(domainOf('PATCH', '/api/projects/p/issues')).toBe('issues, changed at once')
        expect(domainOf('POST', '/api/projects/p/issues/decide')).toBe('a proposal, decided')
        expect(domainOf('POST', '/api/projects/p/issues/P-1/decide')).toBe('a proposal, decided')
        expect(domainOf('GET', '/api/projects/p/issues/P-1/activity')).toBe('activity')
        expect(domainOf('POST', '/api/projects/p/issues/P-1/activity')).toBeUndefined()
    })

    it('checks a session\'s claim on the issue here before a comment\'s edit goes on (ORR-927)', async () => {
        const claimed: string[][] = []
        vi.stubGlobal('claimFor', async (_event: unknown, project: string, issue: string) => {
            claimed.push([project, issue])
        })
        try {
            const line = DOMAINS.find(d => d.domain === 'comments')!
            expect(Object.keys(line.first ?? {})).toEqual(['PATCH'])
            await line.first!.PATCH!({} as never, 'projects/shop%20front/issues/SHO-4/comments/12')
            expect(claimed).toEqual([['shop front', 'SHO-4']])
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('sends milestones and releases there, reads and writes, and keeps a milestone\'s focus here (ORR-926, ORR-974)', () => {
        for (const [method, path] of [['GET', '/api/projects/p/milestones'], ['POST', '/api/projects/p/milestones'], ['GET', '/api/projects/p/milestones/3'],
            ['PATCH', '/api/projects/p/milestones/3'], ['DELETE', '/api/projects/p/milestones/3']]) expect(domainOf(method!, path!), `${method} ${path}`).toBe('milestones')
        for (const [method, path] of [['GET', '/api/projects/p/releases'], ['POST', '/api/projects/p/releases'], ['GET', '/api/projects/p/releases/1.0.0'],
            ['PATCH', '/api/projects/p/releases/1.0.0'], ['DELETE', '/api/projects/p/releases/1.0.0']]) expect(domainOf(method!, path!), `${method} ${path}`).toBe('releases')
        expect(domainOf('GET', '/api/releases')).toBe('releases, every project\'s')
        for (const method of ['POST', 'PATCH', 'DELETE']) expect(domainOf(method, '/api/releases'), method).toBeUndefined()
        for (const path of ['/api/projects/p/milestones/3/focus', '/api/projects/p/releases/1.0.0/notes', '/api/releases/x']) expect(domainOf('GET', path), path).toBeUndefined()
        expect(domainOf('POST', '/api/projects/p/milestones/3/focus')).toBeUndefined()
    })

    it('sends people, removing one included, invites, keys and logins there, and keeps logging in (ORR-928)', () => {
        for (const [method, path] of [['GET', '/api/people'], ['POST', '/api/people'], ['PATCH', '/api/people/ada'], ['DELETE', '/api/people/ada']]) expect(domainOf(method!, path!), path).toBe('people')
        expect(domainOf('POST', '/api/invites')).toBe('invites')
        for (const [method, path] of [['GET', '/api/keys'], ['POST', '/api/keys'], ['DELETE', '/api/keys/abc']]) expect(domainOf(method!, path!), path).toBe('keys')
        for (const [method, path] of [['GET', '/api/logins'], ['DELETE', '/api/logins'], ['DELETE', '/api/logins/0123456789abcdef']]) expect(domainOf(method!, path!), path).toBe('logins')
        for (const path of ['/api/auth/login', '/api/auth/logout', '/api/auth/status', '/api/auth/oidc/start', '/api/owner']) expect(domainOf('POST', path), path).toBeUndefined()
        expect(loginHeaders({provider: true, off: true}, 'https://orrery.example')).toEqual({'Orrery-Login-Ways': 'provider, off', 'Orrery-Origin': 'https%3A%2F%2Forrery.example'})
        expect(loginHeaders({provider: false, off: false}, 'http://localhost:9000')).toEqual({'Orrery-Origin': 'http%3A%2F%2Flocalhost%3A9000'})
    })

    it('sends an uploaded image\'s read there, and keeps uploading one here (ORR-927)', () => {
        expect(domainOf('GET', '/api/uploads/0123456789abcdef01234567')).toBe('uploads, reading')
        expect(domainOf('POST', '/api/uploads')).toBeUndefined()
        for (const path of ['/api/uploads', '/api/uploads/x/y']) expect(domainOf('GET', path), path).toBeUndefined()
    })

    it('sends presets there, and counts a new one of the orrery\'s toward the owner\'s use (ORR-949)', () => {
        for (const path of ['/api/presets', '/api/presets/defaults', '/api/presets/12', '/api/presets/pst-12-x7k2m3qd/reset', '/api/projects/p/presets']) expect(domainOf('POST', path), path).toBe('presets')
        for (const path of ['/api/presets/12/other', '/api/projects/p/presets/12', '/api/presetsx']) expect(domainOf('GET', path), path).toBeUndefined()
        expect(countedOf('POST', '/api/presets')).toBe('presets')
        expect(countedOf('POST', '/api/presets/')).toBe('presets')
        for (const [method, path] of [['GET', '/api/presets'], ['POST', '/api/projects/p/presets'], ['POST', '/api/presets/defaults']]) expect(countedOf(method!, path!), `${method} ${path}`).toBeUndefined()
    })

    it('sends the secrets\' reads there, and keeps every write and egress here (ORR-953)', () => {
        for (const path of ['/api/secrets', '/api/secrets/STRIPE_KEY']) {
            expect(domainOf('GET', path), path).toBe('secrets, reading')
            for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) expect(domainOf(method, path), `${method} ${path}`).toBeUndefined()
        }
        for (const path of ['/api/secrets/STRIPE_KEY/uses', '/api/egress']) expect(domainOf('GET', path), path).toBeUndefined()
        expect(domainOf('POST', '/api/egress')).toBeUndefined()
    })

    it('says what the credential was, and a login only hashed', () => {
        expect(whoHeaders(undefined, undefined)).toEqual({})
        expect(whoHeaders({person: 'åse', owner: false, via: 'browser'}, 'abc')).toEqual({
            'Orrery-Who': 'browser', 'Orrery-Who-Person': '%C3%A5se', 'Orrery-Who-Owner': '0',
            'Orrery-Login': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        })
    })

    it('says who\'s asking in ASCII, and reads back what happened', () => {
        expect(actorHeaders({name: 'Åse', owner: true, session: 'orrery · Njord'})).toEqual({'Orrery-Actor-Name': '%C3%85se', 'Orrery-Actor-Owner': '1', 'Orrery-Actor-Kind': 'owner', 'Orrery-Actor-Session': 'orrery%20%C2%B7%20Njord'})
        // Its kind as `kindOf` has it (ORR-952): the chat and an untrusted session naming the owner aren't the owner.
        expect(actorHeaders({name: 'Åse', owner: true, chat: true})['Orrery-Actor-Kind']).toBe('chat')
        expect(actorHeaders({name: 'Åse', owner: true, untrusted: true, chat: true})['Orrery-Actor-Kind']).toBe('untrusted')
        expect(actorHeaders({name: 'agent', owner: false})['Orrery-Actor-Kind']).toBe('session')
        expect(toldOf('doc.created orrery how%2Dit, doc.changed orrery x')).toEqual([{type: 'doc.created', project: 'orrery', subject: 'how-it'}, {type: 'doc.changed', project: 'orrery', subject: 'x'}])
        expect(toldOf(null)).toEqual([])
        // Where a value went, `~` for none (ORR-927).
        expect(toldOf('issue.assignee orrery ORR%2D1 ~ steffen, comment.asks orrery ORR%2D1 ~ decision')).toEqual([
            {type: 'issue.assignee', project: 'orrery', subject: 'ORR-1', from: null, to: 'steffen'}, {type: 'comment.asks', project: 'orrery', subject: 'ORR-1', from: null, to: 'decision'},
        ])
        expect(toldOf('issue.assignee orrery ORR%2D1 claude %7E')[0]).toMatchObject({from: 'claude', to: '~'})
        const said = (headers: Record<string, string>) => handedOn(new Headers(headers))
        expect(said({'Orrery-Carry': 'shop%20front ORR%2D1 12', 'Orrery-Notice': 'shop%20front ORR%2D1 12'})).toEqual({project: 'shop front', issue: 'ORR-1', comment: 12, carry: true, notice: true, edited: false, quiet: false})
        expect(said({'Orrery-Notice': 'orrery ORR%2D1 12'})).toMatchObject({carry: false, notice: true})
        expect(said({})).toBeUndefined()
        expect(said({'Orrery-Carry': 'orrery ORR%2D1 12 edited'})).toMatchObject({carry: true, notice: false, edited: true})
        expect(said({'Orrery-Carry': 'orrery ORR%2D1 12 quiet'})).toMatchObject({carry: true, edited: false, quiet: true})
        expect(handoffsOf(new Headers({'Orrery-Carry': 'p P%2D1 3, p P-2 4 quiet', 'Orrery-Notice': 'p P-2 4 quiet'}))).toEqual([
            {project: 'p', issue: 'P-1', comment: 3, carry: true, notice: false, edited: false, quiet: false},
            {project: 'p', issue: 'P-2', comment: 4, carry: true, notice: true, edited: false, quiet: true},
        ])
        expect(changedOf('orrery, shop%20front')).toEqual(['orrery', 'shop front'])
        expect(changedOf(null)).toEqual([])
    })

    // Last, once every step above has run: each route the API serves was driven by one of them (ORR-1010), so a route
    // moved without a step here fails. Skipped when they didn't run (no binary, or a filter left them out).
    it('drives every route of the contract at least once, those written ahead too', context => {
        if (!reached.size) context.skip()
        expect(unreached()).toEqual([])
    })
})

describe('the contract (api/openapi.yaml)', () => {
    /** The Nuxt server's routes the router sends on. */
    const routes = () => nuxtRoutes().filter(route => servedByApi(methodOf(route), pathOf(route)))

    it('has every route the router sends to the API, and no other', () => {
        expect(contract()).toHaveLength(98)
        expect(contract()).toEqual(routes())
    })

    it('sends none of the routes written ahead of the Rust API to it', () => {
        expect(contract(true)).toEqual(['DELETE /api/chats/{chat}', 'GET /api/auth/oidc/callback', 'GET /api/auth/oidc/start', 'GET /api/auth/status', 'GET /api/chats', 'GET /api/chats/{chat}', 'GET /api/projects/{project}', 'POST /api/auth/link', 'POST /api/auth/login', 'POST /api/auth/logout', 'POST /api/phone/link', 'POST /api/pulls/forget', 'PUT /api/chats/{chat}', 'PUT /api/pulls/{owner}/{name}', 'PUT /api/pulls/{owner}/{name}/error', 'PUT /api/pulls/{owner}/{name}/history', 'PUT /api/pulls/{owner}/{name}/{number}'])
        expect(contract(true).filter(operation => routes().includes(operation))).toEqual([])
    })
})
