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
import {actorHeaders, changedOf, countedOf, databaseMark, domainOf, DOMAINS, loginHeaders, passedThrough, servedByApi, toldOf, whoHeaders} from '../server/utils/api-router'
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

    it('lists people, and makes, lists and revokes keys and ends logins alike (ORR-928)', async () => {
        await store.nameOwner({name: 'Steffen'})
        await store.addPerson({name: 'Ada'})
        await store.addPerson({name: 'Bob'})
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
        for (const path of ['/api/projects/p/docs/d/artifact', '/api/projects/p', '/api/projects/p/docs/d/revisions/3/other', '/api/docs']) expect(servedByApi('GET', path), path).toBe(false)
        for (const path of ['/api/statuses', '/api/statuses/', '/api/statuses/in-review']) expect(servedByApi('GET', path), path).toBe(true)
        for (const path of ['/api/statuses/x/y', '/api/projects/p/statuses', '/api/settings']) expect(servedByApi('GET', path), path).toBe(false)
    })

    it('routes by a table with a line per domain, so taking one back is taking its line out (ORR-925)', () => {
        expect(DOMAINS.map(({domain}) => domain)).toEqual(['docs', 'statuses', 'issues, reading', 'comments, reading', 'activity', 'milestones and releases, reading', 'people, but removing one', 'invites', 'keys', 'logins', 'uploads, reading', 'presets'])
        expect(domainOf('PATCH', '/api/projects/p/docs/d')).toBe('docs')
        expect(domainOf('head', '/api/projects/p/doc-sections/')).toBe('docs')
        for (const path of ['/api/projects/p/issues/P-1/activity/x', '/api/', '/docs', '/api/projects/p/docs/d/artifact']) expect(domainOf('GET', path), path).toBeUndefined()
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
        expect(domainOf('GET', '/api/projects/p/issues/P-1/activity')).toBe('activity')
        expect(domainOf('POST', '/api/projects/p/issues/P-1/activity')).toBeUndefined()
    })

    it('sends milestones\' and releases\' reads to the API, and keeps their writes and a milestone\'s focus here (ORR-926)', () => {
        for (const path of ['/api/projects/p/milestones', '/api/projects/p/milestones/3', '/api/projects/p/releases', '/api/projects/p/releases/1.0.0', '/api/releases']) {
            expect(domainOf('GET', path), path).toBe('milestones and releases, reading')
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

    it('says what the credential was, and a login only hashed', () => {
        expect(whoHeaders(undefined, undefined)).toEqual({})
        expect(whoHeaders({person: 'åse', owner: false, via: 'browser'}, 'abc')).toEqual({
            'Orrery-Who': 'browser', 'Orrery-Who-Person': '%C3%A5se', 'Orrery-Who-Owner': '0',
            'Orrery-Login': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        })
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
        expect(contract()).toHaveLength(47)
        expect(contract()).toEqual(routes())
    })

    it('sends none of the routes written ahead of the Rust API to it', () => {
        expect(contract(true)).toHaveLength(0)
        expect(contract(true).filter(operation => routes().includes(operation))).toEqual([])
    })
})
