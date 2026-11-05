// The Rust API's docs (ORR-922, api/) and comment reads (ORR-927) against the store's: the same steps, one project through each, on one database
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
import type {Actor} from '../server/store/schema'
import {SqliteDb} from '../server/utils/database'
import {openDb} from '../server/utils/db'
import {PostgresDb} from '../server/utils/postgres'
import {actorHeaders, databaseMark, domainOf, DOMAINS, servedByApi, toldOf} from '../server/utils/api-router'

const BIN = process.env.ORRERY_API_BIN || fileURLToPath(new URL('../../api/target/debug/orrery-api', import.meta.url))
const TOKEN = 'parity-token-0123456789'
const POSTGRES = process.env.TEST_POSTGRES_URL

/** What a step gave back, either side: its status and body, or its failure, and what it said changed. */
interface Outcome {status: number, body: unknown, changed: string[], told: string[]}

const AGENT: Actor = {name: 'agent', owner: false}
const SESSION: Actor = {name: 'agent', owner: false, session: 'orrery · Njord'}
const OWNER: Actor = {name: 'steffen', owner: true}

let store: Store
let api: ChildProcess
let url = ''
let setting = ''
const changes: string[] = []
const events: OrreryEvent[] = []

describe.skipIf(!existsSync(BIN))('the Rust API serves docs and reads comments as the store does', () => {
    beforeAll(async () => {
        const schema = `test_api_${Date.now().toString(36)}`
        if (POSTGRES) {
            setting = POSTGRES
            store = new Store(new PostgresDb(POSTGRES, schema), project => changes.push(project))
        } else {
            setting = resolve(join(mkdtempSync(join(tmpdir(), 'orrery-api-')), 'orrery.db'))
            store = new Store(new SqliteDb(openDb(setting)), project => changes.push(project))
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
        const [before, told] = [changes.length, events.length]
        try {
            const value = await step()
            const made = value && typeof value === 'object' && 'created' in value && 'doc' in value
            const body = made ? (value as {doc: unknown}).doc : value === undefined ? null : value
            return {status: made && (value as {created: boolean}).created ? 201 : body === null ? 204 : status, body, changed: [...new Set(changes.slice(before))], told: events.slice(told).map(e => `${e.type} ${e.subject}`)}
        } catch (error) {
            const {statusCode, message, data} = error as {statusCode: number, message: string, data?: unknown}
            return {status: statusCode, body: {message, ...data === undefined ? {} : {data}}, changed: [], told: []}
        }
    }

    /** The same step through the API. */
    async function viaApi(method: string, path: string, body?: unknown, actor: Actor = AGENT, project = 'through-api'): Promise<Outcome> {
        const response = await fetch(`${url}/api/projects/${project}${path}`, {
            method,
            headers: {'Content-Type': 'application/json', 'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting), ...actorHeaders(actor)},
            ...body === undefined ? {} : {body: JSON.stringify(body)},
        })
        const text = await response.text()
        const json = text ? JSON.parse(text) as Record<string, unknown> : null
        const changed = response.headers.get('orrery-changed')
        const told = toldOf(response.headers.get('orrery-told')).map(t => `${t.type} ${t.subject}`)
        if (response.status >= 400) return {status: response.status, body: {message: json!.message, ...json!.data === undefined ? {} : {data: json!.data}}, changed: [], told: []}
        return {status: response.status, body: json, changed: changed ? [decodeURIComponent(changed)] : [], told}
    }

    /** Both sides' outcomes with what's bound to differ taken out: the project, its uid and key (in an issue's id too),
     * times, revision and comment ids (numbered across the orrery, so the two projects' interleave), and the order a set
     * came in. */
    function same(outcome: Outcome, project: string): unknown {
        const revisions = new Map<number, number>()
        return JSON.parse(JSON.stringify(outcome, (key, value: unknown) => {
            if (typeof value === 'string') {
                return value.replaceAll(project, '<project>').replace(/\b(STO|API)-(\d+)/g, 'KEY-$2').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '<time>').replace(/-[a-z2-7]{8}$/, '-<uid>')
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

    it('answers only the server in front of it, on its own database', async () => {
        const ask = (headers: Record<string, string>) => fetch(`${url}/api/projects/through-api/docs`, {headers}).then(r => r.status)
        expect(await ask({})).toBe(401)
        expect(await ask({'Orrery-Api-Token': `${TOKEN}x`, 'Orrery-Database': databaseMark(setting)})).toBe(401)
        expect(await ask({'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark('/elsewhere.db')})).toBe(421)
        expect(await ask({'Orrery-Api-Token': TOKEN, 'Orrery-Database': databaseMark(setting)})).toBe(200)
    })
})

describe('the router', () => {
    it('sends the docs domain to the API, and keeps an artifact\'s page and everything else here', () => {
        for (const path of ['/api/projects/p/docs', '/api/projects/p/docs/', '/api/projects/p/docs/d', '/api/projects/p/docs/d/revisions', '/api/projects/p/docs/d/revisions/3',
            '/api/projects/p/docs/d/revisions/3/restore', '/api/projects/p/deleted-docs', '/api/projects/p/doc-sections', '/api/projects/p/doc-sections/how it works']) expect(servedByApi('GET', path), path).toBe(true)
        for (const path of ['/api/projects/p/docs/d/artifact', '/api/projects/p/issues', '/api/projects/p', '/api/projects/p/docs/d/revisions/3/other', '/api/docs']) expect(servedByApi('GET', path), path).toBe(false)
    })

    it('routes by a table with a line per domain, so taking one back is taking its line out (ORR-925)', () => {
        expect(DOMAINS.map(({domain}) => domain)).toEqual(['docs', 'comments, reading'])
        expect(domainOf('PATCH', '/api/projects/p/docs/d')).toBe('docs')
        expect(domainOf('head', '/api/projects/p/doc-sections/')).toBe('docs')
        for (const path of ['/api/projects/p/issues', '/api/', '/docs', '/api/projects/p/docs/d/artifact']) expect(domainOf('GET', path), path).toBeUndefined()
    })

    it('sends only the methods a line names, so a domain\'s reads can move before its writes (ORR-927)', () => {
        expect(domainOf('GET', '/api/projects/p/issues/P-1/comments')).toBe('comments, reading')
        expect(domainOf('HEAD', '/api/projects/p/issues/P-1/comments/3')).toBe('comments, reading')
        for (const method of ['POST', 'PATCH', 'DELETE']) {
            expect(domainOf(method, '/api/projects/p/issues/P-1/comments'), method).toBeUndefined()
            expect(domainOf(method, '/api/projects/p/issues/P-1/comments/3'), method).toBeUndefined()
        }
        for (const path of ['/api/projects/p/issues/P-1', '/api/projects/p/issues/P-1/comments/3/x', '/api/projects/p/issues/P-1/schedule-requests/3']) expect(domainOf('GET', path), path).toBeUndefined()
    })

    it('says who\'s asking in ASCII, and reads back what happened', () => {
        expect(actorHeaders({name: 'Åse', owner: true, session: 'orrery · Njord'})).toEqual({'Orrery-Actor-Name': '%C3%85se', 'Orrery-Actor-Owner': '1', 'Orrery-Actor-Session': 'orrery%20%C2%B7%20Njord'})
        expect(toldOf('doc.created orrery how%2Dit, doc.changed orrery x')).toEqual([{type: 'doc.created', project: 'orrery', subject: 'how-it'}, {type: 'doc.changed', project: 'orrery', subject: 'x'}])
        expect(toldOf(null)).toEqual([])
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
        expect(contract()).toHaveLength(16)
        expect(contract()).toEqual(routes())
    })

    it('sends none of the routes written ahead of the Rust API to it', () => {
        expect(contract(true)).toHaveLength(2)
        expect(contract(true).filter(operation => routes().includes(operation))).toEqual([])
    })
})
