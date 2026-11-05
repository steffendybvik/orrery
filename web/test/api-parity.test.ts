// The Rust API's docs (ORR-922, api/), statuses and milestone and release reads (ORR-926), and issue and comment reads (ORR-927) against the store's: the same steps, one project through each, on one database
// (SQLite, or Postgres with TEST_POSTGRES_URL), and the same replies, failures and changes told. The API is the binary
// `cargo build` makes (api/target/debug/orrery-api, or ORRERY_API_BIN); without one this is skipped, and CI's `api` job
// builds it first.
import type {ChildProcess} from 'node:child_process'
import {spawn} from 'node:child_process'
import {existsSync, mkdtempSync, readdirSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, relative, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import type {OrreryEvent} from '#shared/happenings'
import {Store} from '../server/utils/store'
import type {Actor, IssueFilter} from '../server/store/schema'
import {SqliteDb} from '../server/utils/database'
import {Secrets} from '../server/utils/secrets'
import {Pulls, pullForSession} from '../server/utils/pulls'
import {openDb} from '../server/utils/db'
import {PostgresDb} from '../server/utils/postgres'
import {actorHeaders, changedOf, countedOf, databaseMark, domainOf, DOMAINS, handedOn, loginHeaders, passedThrough, servedByApi, toldOf, whoHeaders} from '../server/utils/api-router'
import {permission, refused} from '../server/utils/permission'

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
const changes: string[] = []
const events: OrreryEvent[] = []
let settingsTold = 0
const inFlight = new Set<Promise<unknown>>()

describe.skipIf(!existsSync(BIN))('the Rust API serves docs and the statuses, and reads issues and comments, as the store does', () => {
    beforeAll(async () => {
        const schema = `test_api_${Date.now().toString(36)}`
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

    /** Waits for the store's queries in flight, and what they tell once they answer. */
    async function settle() {
        while (inFlight.size) await Promise.allSettled([...inFlight])
        await new Promise(done => setImmediate(done))
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
                status: made && (value as {created: boolean}).created ? 201 : body === null ? 204 : status, body, changed: [...new Set(changes.slice(before))].sort(),
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
        const handoff = handedOn(response.headers)
        if (handoff) await store.handOn(handoff.project, handoff.issue, handoff.comment, handoff, actor)
        return {status: response.status, body: json, changed: [...new Set(changedOf(changed))].sort(), told, settings: response.headers.get('orrery-settings') === '1'}
    }

    /** Both sides' outcomes with what's bound to differ taken out: the project, its uid and key (in an issue's id too),
     * times, revision and comment ids (numbered across the orrery, so the two projects' interleave), and the order a set
     * came in. */
    function same(outcome: Outcome, project: string): unknown {
        const revisions = new Map<number, number>()
        return JSON.parse(JSON.stringify(outcome, (key, value: unknown) => {
            if (typeof value === 'string') {
                return value.replaceAll(project, '<project>').replace(/\b(STO|API)([DP]?)-(\d+)/g, 'KEY$2-$3').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '<time>').replace(/-[a-z2-7]{8}$/, '-<uid>')
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
        // The steps compared something.
        const frame = await viaApi('GET', `/milestones/${ids['through-api']!.frame}`)
        expect(frame.body).toMatchObject({column: 'in-progress', summary: 'Square and glued', aliases: ['77'], issues: [ids['through-api']!.legs]})
        const shared = await viaApi('GET', '/releases/2.1.0')
        expect(shared.body).toMatchObject({issues: 4, projects: [{project: 'through-api', issues: 3}, {project: 'through-api-drawing', issues: 1}]})
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
            step('the machine\'s own', {terminal: 'ghostty', advanced: false, restrict_proposals: false, pick_next: true, count_use: true}),
            step('instructions, a tracker and the sidebar', {instructions: [{id: 'a1', text: ' Be brief ', on: false}, {id: 'b2', text: 'Test first'}], tracker: 'https://t.example/i/{id}', starred: [' api ', 'web', 'api', 'gone'], hidden: ['gone']}),
            step('starts', {starts: {limit: 3, min: 1, minutes: 60, idle_minutes: 30, on_signal: false}}),
            step('work kinds', {work_kinds: [{id: 'bug', name: ' Bug ', labels: ['Bug', 'bug', 'defect'], model: 'claude-opus-5-5', effort: 'high'}, {id: 'other', name: 'Other', labels: [], model: 'best'}]}),
            read,
            step('everything wrong at once', {bogus: 1, tint: 'pink', terminal: 'xterm', handle: '-x', tracker: 'https://t.example/i', advanced: 'yes', pick_next: null, starred: [''], instructions: [{text: ' '}], focus_prompt: 5}),
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

    it('keeps what each write set off in the outbox, in order, to read after an id (ORR-929)', async () => {
        const read = async (after?: number) => (await viaApi('GET', `/api/changes${after === undefined ? '' : `?after=${after}`}`)).body as {changes: {id: number, kind: string, project?: string, subject?: string, actor?: string, owner: boolean, session?: string}[], last: number}
        const {last} = await read()
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

    it('streams the outbox as server-sent events, live, and says when a cursor has gone (ORR-929)', async () => {
        const headers = {'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...actorHeaders(SESSION)}
        // The newest id, a page at a time, so the stream opens after every row there is.
        let last = 0
        for (let page; (page = (await viaApi('GET', `/api/changes?after=${last}`)).body as {changes: unknown[], last: number}).changes.length;) last = page.last
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
        const last = async () => ((await viaApi('GET', '/api/changes')).body as {last: number}).last
        const read = async (after: number) => ((await viaApi('GET', `/api/changes?after=${after}`)).body as {changes: {kind: string, project?: string}[]}).changes
        expect((await viaApi('POST', '/doc-sections', {name: 'Outbound'})).status).toBe(201)
        const made = await last()
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
        expect(DOMAINS.map(({domain}) => domain)).toEqual(['docs', 'statuses', 'issues, reading', 'comments, but editing one', 'activity', 'milestones', 'releases, reading', 'people, but removing one', 'invites', 'keys', 'logins', 'uploads, reading', 'presets', 'secrets, reading', 'settings', 'a pull request, reading'])
        expect(domainOf('PATCH', '/api/projects/p/docs/d')).toBe('docs')
        expect(domainOf('head', '/api/projects/p/doc-sections/')).toBe('docs')
        for (const path of ['/api/projects/p/issues/P-1/activity/x', '/api/', '/docs', '/api/projects/p/docs/d/artifact']) expect(domainOf('GET', path), path).toBeUndefined()
    })

    it('sends only the methods a line names, so a domain\'s reads can move before its writes (ORR-927)', () => {
        expect(domainOf('GET', '/api/projects/p/issues/P-1/comments')).toBe('comments, but editing one')
        expect(domainOf('HEAD', '/api/projects/p/issues/P-1/comments/3')).toBe('comments, but editing one')
        expect(domainOf('POST', '/api/projects/p/issues/P-1/comments')).toBe('comments, but editing one')
        expect(domainOf('DELETE', '/api/projects/p/issues/P-1/comments/3')).toBe('comments, but editing one')
        // Editing one checks the session's claim on the issue first, here.
        expect(domainOf('PATCH', '/api/projects/p/issues/P-1/comments/3')).toBeUndefined()
        for (const path of ['/api/projects/p/issues/P-1/comments/3/x', '/api/projects/p/issues/P-1/schedule-requests/3', '/api/projects/p/issues/P-1/branches']) expect(domainOf('GET', path), path).toBeUndefined()
        expect(domainOf('GET', '/api/projects/p/issues')).toBe('issues, reading')
        expect(domainOf('GET', '/api/projects/p/issues/P-1')).toBe('issues, reading')
        for (const method of ['POST', 'PATCH', 'DELETE']) expect(domainOf(method, '/api/projects/p/issues'), method).toBeUndefined()
        expect(domainOf('POST', '/api/projects/p/issues/decide')).toBeUndefined()
        expect(domainOf('GET', '/api/projects/p/issues/P-1/activity')).toBe('activity')
        expect(domainOf('POST', '/api/projects/p/issues/P-1/activity')).toBeUndefined()
    })

    it('sends milestones there, reads and writes, and releases\' reads, and keeps releases\' writes and a milestone\'s focus here (ORR-926, ORR-974)', () => {
        for (const [method, path] of [['GET', '/api/projects/p/milestones'], ['POST', '/api/projects/p/milestones'], ['GET', '/api/projects/p/milestones/3'],
            ['PATCH', '/api/projects/p/milestones/3'], ['DELETE', '/api/projects/p/milestones/3']]) expect(domainOf(method!, path!), `${method} ${path}`).toBe('milestones')
        for (const path of ['/api/projects/p/releases', '/api/projects/p/releases/1.0.0', '/api/releases']) {
            expect(domainOf('GET', path), path).toBe('releases, reading')
            for (const method of ['POST', 'PATCH', 'DELETE']) expect(domainOf(method, path), `${method} ${path}`).toBeUndefined()
        }
        for (const path of ['/api/projects/p/milestones/3/focus', '/api/projects/p/releases/1.0.0/notes', '/api/releases/x']) expect(domainOf('GET', path), path).toBeUndefined()
        expect(domainOf('POST', '/api/projects/p/milestones/3/focus')).toBeUndefined()
    })

    it('sends people but removing one, invites, keys and logins there, and keeps logging in (ORR-928)', () => {
        for (const [method, path] of [['GET', '/api/people'], ['POST', '/api/people'], ['PATCH', '/api/people/ada']]) expect(domainOf(method!, path!), path).toBe('people, but removing one')
        expect(domainOf('DELETE', '/api/people/ada')).toBeUndefined()
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
        expect(said({'Orrery-Carry': 'shop%20front ORR%2D1 12', 'Orrery-Notice': 'shop%20front ORR%2D1 12'})).toEqual({project: 'shop front', issue: 'ORR-1', comment: 12, carry: true, notice: true})
        expect(said({'Orrery-Notice': 'orrery ORR%2D1 12'})).toMatchObject({carry: false, notice: true})
        expect(said({})).toBeUndefined()
        expect(changedOf('orrery, shop%20front')).toEqual(['orrery', 'shop front'])
        expect(changedOf(null)).toEqual([])
    })
})

describe('the contract (api/openapi.yaml)', () => {
    /** Its operations, `METHOD /path`, read off its lines: a path at two spaces in, its methods at four. One with
     * `x-served: false` at six is written ahead of the Rust API's (the contract comes first): `ahead` has those. */
    function contract(ahead = false): string[] {
        const text = readFileSync(fileURLToPath(new URL('../../api/openapi.yaml', import.meta.url)), 'utf8')
        const operations: {operation: string, ahead: boolean}[] = []
        let path = ''
        for (const line of text.split('\n')) {
            const at = /^ {2}(\/api\/\S+):$/.exec(line)
            if (at) path = at[1]!
            else if (/^\S/.test(line)) path = ''
            const method = /^ {4}(get|put|post|patch|delete):/.exec(line)
            if (path && method) operations.push({operation: `${method[1]!.toUpperCase()} ${path}`, ahead: false})
            else if (path && operations.length && /^ {6}x-served: false\s*$/.test(line)) operations.at(-1)!.ahead = true
        }
        return operations.filter(o => o.ahead === ahead).map(o => o.operation).sort()
    }

    /** The Nuxt server's routes the router sends on, as `METHOD /path` with `{param}`s. */
    function routes(): string[] {
        const root = fileURLToPath(new URL('../server/api', import.meta.url))
        const walk = (dir: string): string[] => readdirSync(dir, {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
        return walk(root).map(file => {
            const [, route = '', method = ''] = /^(.*?)\.(get|put|post|patch|delete)\.ts$/.exec(relative(root, file)) ?? []
            return {method: method.toUpperCase(), path: `/api/${route}`.replace(/\/index$/, '').replace(/\[(\w+)\]/g, '{$1}')}
        }).filter(({method, path}) => method && servedByApi(method, path.replace(/\{\w+\}/g, 'x'))).map(({method, path}) => `${method} ${path}`).sort()
    }

    it('has every route the router sends to the API, and no other', () => {
        expect(contract()).toHaveLength(57)
        expect(contract()).toEqual(routes())
    })

    it('sends none of the routes written ahead of the Rust API to it', () => {
        expect(contract(true)).toHaveLength(0)
        expect(contract(true).filter(operation => routes().includes(operation))).toEqual([])
    })
})
