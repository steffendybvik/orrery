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
import {openDb} from '../server/utils/db'
import {PostgresDb} from '../server/utils/postgres'
import {actorHeaders, changedOf, databaseMark, domainOf, DOMAINS, servedByApi, toldOf} from '../server/utils/api-router'

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

    /** A step through the store, as its route would answer it. */
    async function viaStore(step: () => Promise<unknown>, status = 200): Promise<Outcome> {
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

    /** The same step through the API. */
    async function viaApi(method: string, path: string, body?: unknown, actor: Actor = AGENT, project = 'through-api'): Promise<Outcome> {
        // A path of the orrery's own (`/api/statuses`) as it is; else one of the project's.
        const response = await fetch(path.startsWith('/api/') ? `${url}${path}` : `${url}/api/projects/${project}${path}`, {
            method,
            headers: {'Content-Type': 'application/json', 'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...actorHeaders(actor)},
            ...body === undefined ? {} : {body: JSON.stringify(body)},
        })
        const text = await response.text()
        const json = text ? JSON.parse(text) as Record<string, unknown> : null
        const changed = response.headers.get('orrery-changed')
        const told = toldOf(response.headers.get('orrery-told')).map(t => `${t.type} ${t.subject}`)
        if (response.status >= 400) return {status: response.status, body: {message: json!.message, ...json!.data === undefined ? {} : {data: json!.data}}, changed: [], told: [], settings: false}
        return {status: response.status, body: json, changed: [...new Set(changedOf(changed))].sort(), told, settings: response.headers.get('orrery-settings') === '1'}
    }

    /** Both sides' outcomes with what's bound to differ taken out: the project, its uid and key (in an issue's id too),
     * times, revision and comment ids (numbered across the orrery, so the two projects' interleave), and the order a set
     * came in. */
    function same(outcome: Outcome, project: string): unknown {
        const revisions = new Map<number, number>()
        return JSON.parse(JSON.stringify(outcome, (key, value: unknown) => {
            if (typeof value === 'string') {
                return value.replaceAll(project, '<project>').replace(/\b(STO|API)(D?)-(\d+)/g, 'KEY$2-$3').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '<time>').replace(/-[a-z2-7]{8}$/, '-<uid>')
            }
            if (typeof value === 'number' && (key === 'id' || key === 'revision') && Number.isInteger(value)) {
                if (!revisions.has(value)) revisions.set(value, revisions.size + 1)
                return `rev ${revisions.get(value)}`
            }
            return value
        }))
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

    it('answers only the server in front of it, on its own database', async () => {
        const ask = (headers: Record<string, string>) => fetch(`${url}/api/projects/through-api/docs`, {headers}).then(r => r.status)
        expect(await ask({})).toBe(401)
        expect(await ask({'Orrery-Api-Token': `${TOKEN}x`, 'Orrery-Database': databaseMark(setting)})).toBe(401)
        expect(await ask({'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark('/elsewhere.db')})).toBe(421)
        expect(await ask({'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting)})).toBe(200)
    })
})

describe('the router', () => {
    it('sends the docs domain and the statuses to the API, and keeps an artifact\'s page and everything else here', () => {
        for (const path of ['/api/projects/p/docs', '/api/projects/p/docs/', '/api/projects/p/docs/d', '/api/projects/p/docs/d/revisions', '/api/projects/p/docs/d/revisions/3',
            '/api/projects/p/docs/d/revisions/3/restore', '/api/projects/p/deleted-docs', '/api/projects/p/doc-sections', '/api/projects/p/doc-sections/how it works']) expect(servedByApi('GET', path), path).toBe(true)
        for (const path of ['/api/projects/p/docs/d/artifact', '/api/projects/p/issues/P-1/activity', '/api/projects/p', '/api/projects/p/docs/d/revisions/3/other', '/api/docs']) expect(servedByApi('GET', path), path).toBe(false)
        for (const path of ['/api/statuses', '/api/statuses/', '/api/statuses/in-review']) expect(servedByApi('GET', path), path).toBe(true)
        for (const path of ['/api/statuses/x/y', '/api/projects/p/statuses', '/api/settings']) expect(servedByApi('GET', path), path).toBe(false)
    })

    it('routes by a table with a line per domain, so taking one back is taking its line out (ORR-925)', () => {
        expect(DOMAINS.map(({domain}) => domain)).toEqual(['docs', 'statuses', 'issues, reading', 'comments, reading', 'milestones and releases, reading'])
        expect(domainOf('PATCH', '/api/projects/p/docs/d')).toBe('docs')
        expect(domainOf('head', '/api/projects/p/doc-sections/')).toBe('docs')
        for (const path of ['/api/projects/p/issues/P-1/activity', '/api/', '/docs', '/api/projects/p/docs/d/artifact']) expect(domainOf('GET', path), path).toBeUndefined()
    })

    it('sends only the methods a line names, so a domain\'s reads can move before its writes (ORR-927)', () => {
        expect(domainOf('GET', '/api/projects/p/issues/P-1/comments')).toBe('comments, reading')
        expect(domainOf('HEAD', '/api/projects/p/issues/P-1/comments/3')).toBe('comments, reading')
        for (const method of ['POST', 'PATCH', 'DELETE']) {
            expect(domainOf(method, '/api/projects/p/issues/P-1/comments'), method).toBeUndefined()
            expect(domainOf(method, '/api/projects/p/issues/P-1/comments/3'), method).toBeUndefined()
        }
        for (const path of ['/api/projects/p/issues/P-1/comments/3/x', '/api/projects/p/issues/P-1/schedule-requests/3', '/api/projects/p/issues/P-1/branches']) expect(domainOf('GET', path), path).toBeUndefined()
        expect(domainOf('GET', '/api/projects/p/issues')).toBe('issues, reading')
        expect(domainOf('GET', '/api/projects/p/issues/P-1')).toBe('issues, reading')
        for (const method of ['POST', 'PATCH', 'DELETE']) expect(domainOf(method, '/api/projects/p/issues'), method).toBeUndefined()
        expect(domainOf('POST', '/api/projects/p/issues/decide')).toBeUndefined()
    })

    it('sends milestones\' and releases\' reads to the API, and keeps their writes and a milestone\'s focus here (ORR-926)', () => {
        for (const path of ['/api/projects/p/milestones', '/api/projects/p/milestones/3', '/api/projects/p/releases', '/api/projects/p/releases/1.0.0', '/api/releases']) {
            expect(domainOf('GET', path), path).toBe('milestones and releases, reading')
            for (const method of ['POST', 'PATCH', 'DELETE']) expect(domainOf(method, path), `${method} ${path}`).toBeUndefined()
        }
        for (const path of ['/api/projects/p/milestones/3/focus', '/api/projects/p/releases/1.0.0/notes', '/api/releases/x']) expect(domainOf('GET', path), path).toBeUndefined()
        expect(domainOf('POST', '/api/projects/p/milestones/3/focus')).toBeUndefined()
    })

    it('says who\'s asking in ASCII, and reads back what happened', () => {
        expect(actorHeaders({name: 'Åse', owner: true, session: 'orrery · Njord'})).toEqual({'Orrery-Actor-Name': '%C3%85se', 'Orrery-Actor-Owner': '1', 'Orrery-Actor-Session': 'orrery%20%C2%B7%20Njord'})
        expect(toldOf('doc.created orrery how%2Dit, doc.changed orrery x')).toEqual([{type: 'doc.created', project: 'orrery', subject: 'how-it'}, {type: 'doc.changed', project: 'orrery', subject: 'x'}])
        expect(toldOf(null)).toEqual([])
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
        expect(contract()).toHaveLength(27)
        expect(contract()).toEqual(routes())
    })

    it('sends none of the routes written ahead of the Rust API to it', () => {
        expect(contract(true)).toHaveLength(0)
        expect(contract(true).filter(operation => routes().includes(operation))).toEqual([])
    })
})
