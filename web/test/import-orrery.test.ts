import {describe, expect, it} from 'vitest'
import {RESERVED_KEYS} from '../shared/roadmap/board'
import {RESERVED_KEYS as SCRIPT_RESERVED, PART_SIZE, boardParts, freeId, freeKey, imagesShown, importOrrery, laterLinks, parseArgs, planProjects, planStatuses, prepareFile, rewriteLinks, sendBoard, summary} from '../scripts/import-orrery.mjs'

// `pnpm orrery:import` (ORR-1110): a whole orrery brought in as a new workspace of another. Its planning is pure, so it's
// tested here; the upload it ends in is the Rust API's, tested in board_upload_tests.rs.

describe('free ids and keys', () => {
    it('keeps one that is free, else numbers it within the limits', () => {
        expect(freeId('hub', new Set())).toBe('hub')
        expect(freeId('hub', new Set(['hub', 'hub-2']))).toBe('hub-3')
        const long = 'a'.repeat(40)
        expect(freeId(long, new Set([long]))).toHaveLength(40)
        expect(freeKey('HUB', new Set(['HUB']))).toBe('HUB2')
        expect(freeKey('ABCDEFGHIJ', new Set(['ABCDEFGHIJ']))).toBe('ABCDEFGHI2')
    })
})

describe('planProjects', () => {
    it('renames a clash, puts a release source first, and leaves one already there alone', () => {
        const source = [
            {id: 'app', key: 'APP', name: 'App', releases_from: 'core'},
            {id: 'core', key: 'ORR', name: 'Core'},
            {id: 'docs', key: 'DOC', name: 'Docs'},
        ]
        const target = [{id: 'orrery', key: 'ORR', name: 'orrery'}, {id: 'docs', key: 'DOC', name: 'Docs'}]
        const plan = planProjects(source, target, [{id: 'docs', key: 'DOC', name: 'Docs'}])
        expect(plan.map(p => p.from)).toEqual(['core', 'app', 'docs'])
        expect(plan[0]).toMatchObject({id: 'core', key: 'ORR2', renamed: true})
        expect(plan[1]).toMatchObject({id: 'app', key: 'APP', renamed: false})
        expect(plan[2]).toMatchObject({id: 'docs', skipped: true})
    })

    it('renames a key the target reserves, which an older orrery can have', () => {
        expect(SCRIPT_RESERVED).toEqual(RESERVED_KEYS)
        const plan = planProjects([{id: 'checkout', key: 'CHK', name: 'Checkout'}, {id: 'docs', key: 'DOC', name: 'Docs'}], [])
        expect(plan.map(p => [p.id, p.key, p.renamed])).toEqual([['checkout', 'CHK2', true], ['docs', 'DOC2', true]])
    })
})

describe('links', () => {
    it('rewrites a renamed project\'s page links and nothing that only starts like it', () => {
        const renames = new Map([['hub', 'hub-2']])
        expect(rewriteLinks('See [x](/p/hub/issues/HUB-1) and /p/hubble/docs', renames)).toBe('See [x](/p/hub-2/issues/HUB-1) and /p/hubble/docs')
        expect(rewriteLinks('/p/hub', renames)).toBe('/p/hub-2')
    })

    it('prepares a file without touching the one given, and describes every status', () => {
        const file = {
            project: 'app',
            statuses: [{id: 'todo', name: 'Todo', kind: 'todo'}],
            tables: {
                projects: [{id: 'app', releases_from: 'hub'}],
                issue_links: [{issue: 'APP-1', on_project: 'hub', on_issue: 'HUB-1'}, {issue: 'APP-1', on_project: 'app', on_issue: 'APP-2'}],
                comments: [{body: 'On /p/hub/issues/HUB-1'}],
            },
        }
        const out = prepareFile(file, new Map([['hub', 'hub-2']]), [{id: 'doing', name: 'Doing', kind: 'started'}])
        expect(out.tables.projects[0].releases_from).toBe('hub-2')
        expect(out.tables.issue_links.map((l: {on_project: string}) => l.on_project)).toEqual(['hub-2', 'app'])
        expect(out.tables.comments[0].body).toBe('On /p/hub-2/issues/HUB-1')
        expect(out.statuses.map((s: {id: string}) => s.id)).toEqual(['todo', 'doing'])
        expect(file.tables.comments[0].body).toBe('On /p/hub/issues/HUB-1')
    })

    it('puts back the links to a board brought in after its own', () => {
        const files = new Map([
            ['a', {tables: {issue_links: [{issue: 'A-1', on_project: 'b', on_issue: 'B-1'}, {issue: 'A-1', on_project: 'a', on_issue: 'A-2'}]}}],
            ['b', {tables: {issue_links: [{issue: 'B-1', on_project: 'a', on_issue: 'A-1'}]}}],
        ])
        const plan = [{from: 'a', id: 'a'}, {from: 'b', id: 'b-2'}]
        expect(laterLinks(files, plan)).toEqual([{project: 'a', issue: 'A-1', depends_on: ['b-2/B-1', 'A-2']}])
    })
})

describe('planStatuses', () => {
    it('matches by name and kind, makes the rest with a free id, and drops the workspace\'s own the source lacks', () => {
        const source = [{id: 'todo', name: 'Todo', kind: 'todo'}, {id: 'qa', name: 'QA', kind: 'started'}]
        const target = [{id: 'work-todo', name: 'todo', kind: 'todo'}, {id: 'work-doing', name: 'Doing', kind: 'started'}]
        const plan = planStatuses(source, target, ['work-todo', 'work-doing', 'work-qa'], 'work')
        expect(plan.map.get('todo')).toBe('work-todo')
        expect(plan.make).toEqual([{id: 'work-qa-2', name: 'QA', kind: 'started'}])
        expect(plan.drop).toEqual([{id: 'work-doing', name: 'Doing', into: 'work-qa-2'}])
    })
})

describe('parseArgs', () => {
    it('reads values and flags', () => {
        expect(parseArgs(['--from', 'http://a', '--dry-run', '--name', 'Work'])).toEqual({'from': 'http://a', 'dry-run': true, 'name': 'Work'})
    })
})

/** A fake orrery: GETs answered from `routes`, every write recorded. */
function fake(url: string, routes: Record<string, unknown>) {
    const writes: string[] = []
    const answer = async (path: string) => {
        if (!(path in routes)) throw Object.assign(new Error(`GET ${path}: 404`), {status: 404})
        return structuredClone(routes[path])
    }
    const write = (method: string) => async (path: string) => {
        writes.push(`${method} ${path}`)
        return {}
    }
    return {url, writes, get: answer, post: write('POST'), patch: write('PATCH'), del: write('DELETE'), upload: write('UPLOAD')}
}

describe('importOrrery', () => {
    const source = () => fake('http://work', {
        '/projects': [{id: 'hub', key: 'HUB', name: 'Hub'}, {id: 'orrery', key: 'ORR', name: 'orrery'}],
        '/settings': {tint: 'teal', statuses: [{id: 'todo', name: 'Todo', kind: 'todo'}]},
        '/projects/hub/export': {project: 'hub', tables: {issues: [{id: 'HUB-1'}], schedules: [{id: 1, title: 'Groom', enabled: 1}]}, people: [{id: 'ada', name: 'Ada'}]},
        '/projects/orrery/export': {project: 'orrery', tables: {issues: []}},
        '/secrets': [{name: 'STRIPE', hosts: ['api.stripe.com'], projects: ['orrery']}],
    })
    const target = (workspaces: unknown[] = []) => fake('http://home', {
        '/workspaces': workspaces,
        '/projects': [{id: 'orrery', key: 'ORR', name: 'orrery'}],
        '/people': [{id: 'sam', name: 'sam'}],
    })

    it('plans on a dry run and writes nothing to either', async () => {
        const from = source()
        const to = target()
        const steps: unknown[] = []
        const report = await importOrrery({source: from, target: to, name: 'Work', dryRun: true, progress: (p: unknown) => steps.push(p)})
        // How far it's got, for App settings to show (ORR-1249): each board read, and nothing uploaded on a dry run.
        expect(steps).toEqual([{step: 'reading', project: 'hub', done: 0, total: 2}, {step: 'reading', project: 'orrery', done: 1, total: 2}])
        expect(from.writes).toEqual([])
        expect(to.writes).toEqual([])
        expect(report.projects.map((p: {id: string}) => p.id)).toEqual(['hub', 'orrery-2'])
        expect(report.secrets).toEqual([{name: 'STRIPE', hosts: ['api.stripe.com'], projects: ['orrery-2']}])
        expect(report.people).toEqual(['Ada'])
        expect(report.schedules.wasOn).toEqual(['hub: Groom'])
        const text = summary(report)
        expect(text).toContain('Dry run: nothing was written to http://home.')
        expect(text).toContain('orrery → orrery-2 (key ORR → ORR2)')
    })

    it('refuses a name the target already has unless told to add to it', async () => {
        await expect(importOrrery({source: source(), target: target([{id: 'work', name: 'Work'}]), name: 'work', dryRun: true})).rejects.toThrow(/--add/)
        await expect(importOrrery({source: source(), target: target(), name: 'Work', add: true, dryRun: true})).rejects.toThrow(/no workspace/)
        // An orrery from before workspaces answers the page's HTML.
        const old = fake('http://old', {'/workspaces': '<!DOCTYPE html>'})
        await expect(importOrrery({source: source(), target: old, name: 'Work', dryRun: true})).rejects.toThrow(/http:\/\/old has no workspaces/)
    })
})

// A board too big for one request (ORR-1257): its images one at a time, then its rows in parts.
describe('sending a big board', () => {
    const CAP = 100 * 1024 * 1024
    const image = (n: number) => n.toString(16).padStart(24, '0')

    /** An orrery behind a proxy that refuses a body over Cloudflare's cap, keeping every board it's sent. */
    function behindProxy() {
        const bodies: number[] = []
        const images = new Map<string, number>()
        const boards: {query: URLSearchParams, file: {tables: Record<string, unknown[]>}}[] = []
        const sized = (text: string) => {
            bodies.push(text.length)
            if (text.length > CAP) throw Object.assign(new Error('413 Payload Too Large'), {status: 413})
        }
        return {
            bodies, images, boards,
            post: async (path: string, body: {data: string}) => {
                sized(JSON.stringify(body))
                expect(path).toBe('/uploads')
                const id = image(1000 + images.size)
                images.set(id, body.data.length)
                return {id}
            },
            upload: async (path: string, text: string) => {
                sized(text)
                const query = new URL(path, 'http://x').searchParams
                boards.push({query, file: JSON.parse(text)})
                return {id: query.get('id') ?? 'shop', key: query.get('key') ?? 'SHP'}
            },
        }
    }

    it('gets a board of 150 MB through a proxy capped at 100 MB, every image and row with it', async () => {
        // Twelve images of 9 MB, shown by its comments, and 20 MB of comments: one file of about 150 MB.
        const data = new Map(Array.from({length: 12}, (_, n) => [image(n), 'A'.repeat(12 * 1024 * 1024)]))
        const comments = Array.from({length: 2000}, (_, n) => ({id: n + 1, issue: 'SHP-1', body: `${'words '.repeat(1700)} ![shot](/api/uploads/${image(n % 12)})`}))
        const file = {format: 'orrery-board', format_version: 1, schema_step: 99, project: 'shop', people: [], statuses: [],
            uploads: [...data].map(([id, d]) => ({id, data: d})),
            tables: {projects: [{id: 'shop', key: 'SHP'}], issues: [{id: 'SHP-1'}], comments, issue_events: [{issue: 'SHP-1', field: 'status'}], releases: [{version: '1.0', doc_mark: 7}], doc_revisions: [{id: 7, doc: 'readme'}]}}
        expect(JSON.stringify(file).length).toBeGreaterThan(CAP * 1.4)
        expect(imagesShown(file)).toHaveLength(12)

        const target = behindProxy()
        const board = await sendBoard(target, file, {id: 'shop', key: 'SHP', own: true})
        expect(board).toEqual({id: 'shop', key: 'SHP'})
        expect(Math.max(...target.bodies)).toBeLessThan(CAP)
        // Each image once, on its own.
        expect(target.images.size).toBe(12)
        // The board first, with no images and none of what can come after it, then the rest into it, in parts.
        const [first, ...parts] = target.boards
        expect(first!.query.get('into')).toBeNull()
        expect(first!.file.tables.comments).toEqual([])
        expect((first!.file as {uploads: unknown[]}).uploads).toEqual([])
        expect(parts.length).toBeGreaterThan(1)
        for (const part of parts) {
            expect(Object.fromEntries(part.query)).toEqual({id: 'shop', key: 'SHP', own: '1', into: '1'})
            expect(JSON.stringify(part.file).length).toBeLessThan(PART_SIZE * 1.1)
            expect(part.file.tables.projects).toEqual([{id: 'shop', key: 'SHP'}])
        }
        const arrived = parts.flatMap(part => part.file.tables.comments ?? []) as {id: number, body: string}[]
        expect(arrived.map(c => c.id)).toEqual(comments.map(c => c.id))
        // Its text shows each image by the id it has there.
        expect(arrived.every(c => /\/api\/uploads\/0{20}03[0-9a-f]{2}\)$/.test(c.body))).toBe(true)
        // A release comes with the doc revision it marks.
        const withRevision = parts.find(part => part.file.tables.doc_revisions)!
        expect(withRevision.file.tables.releases).toEqual([{version: '1.0', doc_mark: 7}])
        expect(parts.flatMap(part => part.file.tables.issue_events ?? [])).toHaveLength(1)
    }, 60_000)

    it("keeps a schedule's request with the board, as the comment it points at", () => {
        const file = {tables: {projects: [{id: 'shop'}], comments: [{id: 1}, {id: 2}], schedule_requests: [{comment: 2}]}}
        const {first, parts} = boardParts(file)
        expect(first.tables.comments).toEqual([{id: 2}])
        expect(parts.map(part => part.tables.comments)).toEqual([[{id: 1}]])
    })

    it('reads an image the file leaves out from the source, and sends one shown on two boards once', async () => {
        const target = behindProxy()
        const sent = new Map()
        const read: string[] = []
        const source = async (id: string) => {
            read.push(id)
            return 'iVBORw0K'
        }
        const shows = (project: string) => ({project, tables: {projects: [{id: project}], issues: [{id: 'A-1', notes: `![x](/api/uploads/${image(5)})`}]}})
        await sendBoard(target, shows('a'), {id: 'a', key: 'A', image: source, sent})
        await sendBoard(target, shows('b'), {id: 'b', key: 'B', image: source, sent})
        expect(read).toEqual([image(5)])
        expect(target.boards.map(b => (b.file.tables.issues as {notes: string}[])[0]!.notes)).toEqual([`![x](/api/uploads/${image(1000)})`, `![x](/api/uploads/${image(1000)})`])
    })

    it('says the board came in when a later part fails', async () => {
        const target = behindProxy()
        const upload = target.upload
        target.upload = async (path: string, text: string) => {
            if (path.includes('into=1')) throw new Error('500 Internal Server Error')
            return await upload(path, text)
        }
        const file = {tables: {projects: [{id: 'shop'}], comments: [{id: 1}]}}
        await expect(sendBoard(target, file, {id: 'shop', key: 'SHP'})).rejects.toThrow(/came in as shop, but part 1 of 1/)
    })
})
