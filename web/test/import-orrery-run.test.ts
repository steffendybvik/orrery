import {describe, expect, it} from 'vitest'
import {client, importOrrery, summary} from '../shared/import-orrery.mjs'

// A whole import, past the dry run (ORR-1110, ORR-1249): what it writes to the target, in what order of things, and
// what it reports; and the small HTTP client both sides go through. The planning it uses is tested in
// import-orrery.test.ts, the upload it ends in by the Rust API's own tests.

type Write = {method: string, path: string, body?: unknown, workspace?: string}
type Options = {workspace?: string}

/** An orrery that answers reads from `routes` (by path, or `path@workspace` for one workspace's), and writes with `on`. */
function fake(url: string, routes: Record<string, unknown>, on: Record<string, (body: unknown, path: string) => unknown> = {}) {
    const writes: Write[] = []
    const read = async (path: string, options?: Options) => {
        const key = options?.workspace && `${path}@${options.workspace}` in routes ? `${path}@${options.workspace}` : path
        if (!(key in routes)) throw Object.assign(new Error(`GET ${path}: 404`), {status: 404})
        return structuredClone(routes[key])
    }
    const write = (method: string) => async (path: string, body?: unknown, options?: Options) => {
        const opts = method === 'DELETE' ? body as Options | undefined : options
        writes.push({method, path, ...method === 'DELETE' ? {} : {body}, ...opts?.workspace ? {workspace: opts.workspace} : {}})
        const handler = Object.entries(on).find(([pattern]) => `${method} ${path}`.startsWith(pattern))?.[1]
        return handler ? handler(body, path) : {}
    }
    return {
        url, writes,
        get: read,
        bytes: async (path: string) => {
            writes.push({method: 'BYTES', path})
            return 'QUJD'
        },
        post: write('POST'), patch: write('PATCH'), del: write('DELETE'), upload: write('UPLOAD'),
    }
}

const IMAGE = 'a'.repeat(24)
const source = () => fake('http://work', {
    '/projects': [{id: 'hub', key: 'HUB', name: 'Hub'}, {id: 'kit', key: 'KIT', name: 'Kit'}],
    '/settings': {tint: '#00ff00', focus_prompt: 'Focus', advanced: null, statuses: [
        {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue', position: 0},
        {id: 'review', name: 'Review', kind: 'started', color: 'violet', position: 1},
    ]},
    '/projects/hub/export': {project: 'hub', people: [{id: 'ada', name: 'Ada'}, {id: 'skoll', name: 'Sköll'}], tables: {
        issues: [{id: 'HUB-1', epic: 9}, {id: 'HUB-2'}],
        issue_links: [{issue: 'HUB-1', on_project: 'kit', on_issue: 'KIT-1'}, {issue: 'HUB-1', on_project: 'hub', on_issue: 'HUB-2'}],
        schedules: [{id: 1, title: 'Groom', enabled: 1, presets: '[11]'}, {id: 2, title: 'Nightly', enabled: 1, across: 5}],
        comments: [{id: 1, issue: 'HUB-1', body: `See ![shot](/api/uploads/${IMAGE})`}],
    }},
    '/projects/kit/export': {project: 'kit', tables: {issues: [{id: 'KIT-1'}]}},
    '/secrets': [],
    '/schedules/across': [{id: 5, title: 'Nightly', enabled: 1, kind: 'issue', cron: '0 3 * * *', presets: [11], projects: ['hub', 'gone'], skip: ['kit'], timezone: null}],
    '/presets': [
        {id: 10, project: null, name: 'Reviewer', text: 'Review it, closely', default: {key: 'review', changed: true}},
        {id: 11, project: null, name: 'Mine', text: 'm', icon: 'star', color: 'rose'},
        {id: 12, project: null, name: 'Planner', text: 'p', default: {key: 'plan'}},
        {id: 13, project: 'hub', name: "The board's own", text: 'b'},
    ],
    '/epics': [{id: 9, title: 'Spring', notes: 'The spring work'}, {id: 10, title: 'Summer'}],
    '/epics/9/comments': [{created_by: 'ada', created_at: '2026-11-01T10:00:00Z', body: 'Start with /p/hub/issues/HUB-1'}],
})

/** Where a write landed, as `METHOD path`. */
const said = (writes: Write[]) => writes.map(w => `${w.method} ${w.path}`)
const body = (writes: Write[], line: string) => writes.find(w => `${w.method} ${w.path}` === line)?.body

describe('importOrrery, into a new workspace', () => {
    const target = () => fake('http://home', {
        '/workspaces': [],
        '/projects': [],
        '/people': [{id: 'skoll', name: 'Sköll'}],
        '/statuses@work': [{id: 'w-todo', name: 'Todo', kind: 'todo'}, {id: 'w-doing', name: 'Doing', kind: 'started'}, {id: 'w-done', name: 'Done', kind: 'done'}],
        '/settings': {statuses: [{id: 'work-review', name: 'Review', kind: 'started'}]},
        '/presets@work': [{id: 1, name: 'Reviewer', text: 'Review it', default: {key: 'review'}}, {id: 2, name: 'Tester', text: 't', default: {key: 'test'}}],
        '/projects/hub/schedules': [{id: 41, presets: []}, {id: 40, presets: [7]}],
        '/projects/kit/schedules': [],
    }, {
        'POST /workspaces': () => ({id: 'work', name: 'Work'}),
        'POST /presets/defaults': () => [{id: 3, name: 'Planner', text: 'p', default: {key: 'plan'}}],
        'POST /presets': () => ({id: 101}),
        'POST /uploads': () => ({id: 'b'.repeat(24)}),
        'UPLOAD /projects/upload': (_, path) => {
            const query = new URL(path, 'http://x').searchParams
            return {id: query.get('id'), key: query.get('key')}
        },
        'POST /schedules': () => ({id: 77}),
        'POST /epics/': () => ({}),
        'POST /epics': () => ({id: 600}),
    })

    it('carries the workspace, its boards and what spans them, and reports each part', async () => {
        const from = source()
        const to = target()
        const logged: string[] = []
        const steps: {step: string}[] = []
        const report = await importOrrery({source: from, target: to, name: 'Work', enableSchedules: true, log: (line: string) => logged.push(line), progress: (step: {step: string}) => steps.push(step)})
        const lines = said(to.writes)

        // Read only from the source: the image it shows comes from there too.
        expect(from.writes).toEqual([{method: 'BYTES', path: `/uploads/${IMAGE}`}])

        // The workspace, coloured as the source was, and its own settings, leaving out those unset.
        expect(body(to.writes, 'POST /workspaces')).toEqual({name: 'Work', color: '#00ff00'})
        expect(body(to.writes, 'PATCH /settings')).toEqual({tint: '#00ff00', focus_prompt: 'Focus'})
        expect(report.settings).toEqual(['tint', 'focus_prompt'])

        // Statuses: Todo matched and recoloured, Review made with its own id, as another workspace's is no clash (ORR-1442),
        // Doing moved into it and dropped, and Done left as nothing takes its kind.
        expect(body(to.writes, 'POST /statuses')).toEqual({id: 'review', name: 'Review', kind: 'started', color: 'violet', position: 1})
        expect(lines).toContain('DELETE /statuses/w-doing?into=review')
        expect(lines).not.toContain('DELETE /statuses/w-done?into=undefined')
        expect(body(to.writes, 'PATCH /statuses/w-todo')).toEqual({color: 'blue', position: 0})
        expect(report.statuses).toEqual({matched: 1, made: ['Review'], dropped: ['Doing']})

        // Presets: orrery's own brought back, the changed one rewritten, the source's own made, and one the source
        // dropped removed; a board's own preset stays with its board.
        expect(lines).toContain('POST /presets/defaults')
        expect(body(to.writes, 'PATCH /presets/1')).toEqual({name: 'Reviewer', text: 'Review it, closely', icon: null, color: null})
        expect(body(to.writes, 'POST /presets')).toEqual({name: 'Mine', text: 'm', icon: 'star', color: 'rose'})
        expect(lines).toContain('DELETE /presets/2')
        expect(lines).not.toContain('PATCH /presets/3')
        expect(report.presets).toEqual({made: 1, shipped: 2, removed: 1})

        // The boards: the image first, then each board as its own, its comments in a part after it.
        expect(lines.filter(l => l.startsWith('UPLOAD'))).toEqual(['UPLOAD /projects/upload?id=hub&key=HUB&own=1', 'UPLOAD /projects/upload?id=hub&key=HUB&own=1&into=1', 'UPLOAD /projects/upload?id=kit&key=KIT&own=1'])
        expect(body(to.writes, 'POST /uploads')).toEqual({data: 'QUJD'})
        const hub = JSON.parse(body(to.writes, 'UPLOAD /projects/upload?id=hub&key=HUB&own=1') as string)
        expect(hub.statuses.map((s: {id: string}) => s.id)).toEqual(['todo', 'review'])
        const later = JSON.parse(body(to.writes, 'UPLOAD /projects/upload?id=hub&key=HUB&own=1&into=1') as string)
        expect(later.tables.comments[0].body).toBe(`See ![shot](/api/uploads/${'b'.repeat(24)})`)
        expect(steps.map(s => s.step)).toEqual(['reading', 'reading', 'uploading', 'uploading', 'finishing'])

        // The link to the board brought in after it, put back; the preset its schedule named, added to it.
        expect(body(to.writes, 'PATCH /projects/hub/issues/HUB-1')).toEqual({depends_on: ['kit/KIT-1', 'HUB-2']})
        expect(body(to.writes, 'PATCH /projects/hub/schedules/40')).toEqual({presets: [7, 101]})

        // The schedule across projects made again over the new ones, off, its plain copy removed, then turned on.
        expect(lines).toContain('DELETE /projects/hub/schedules/41')
        expect(body(to.writes, 'POST /schedules')).toEqual({kind: 'issue', title: 'Nightly', cron: '0 3 * * *', presets: [101], projects: ['hub'], skip: ['kit'], enabled: false})
        expect(body(to.writes, 'PATCH /schedules/across/77')).toEqual({enabled: true})
        expect(to.writes.filter(w => w.path === '/projects/hub/schedules/40').map(w => w.body)).toEqual([{presets: [7, 101]}, {enabled: true}])
        expect(report.schedules).toEqual({enabled: true, wasOn: ['hub: Groom', 'across: Nightly'], turnedOn: 2})
        expect(report.across).toEqual({made: 1})

        // Epics, their comments written as you with who said it first, and their issues put back in them.
        expect(body(to.writes, 'POST /epics')).toEqual({title: 'Spring', notes: 'The spring work', position: 0})
        expect(to.writes.filter(w => w.path === '/epics').map(w => w.body)).toEqual([{title: 'Spring', notes: 'The spring work', position: 0}, {title: 'Summer', position: 1}])
        expect(body(to.writes, 'POST /epics/600/comments')).toEqual({body: '*ada, 2026-11-01:*\n\nStart with /p/hub/issues/HUB-1'})
        expect(to.writes.filter(w => w.path === '/projects/hub/issues/HUB-1').map(w => w.body)).toContainEqual({epic: 600})
        expect(report.epics).toEqual({made: 2, comments: 1, issues: 1})

        // Everything the workspace holds is written in it.
        for (const w of to.writes.filter(w => ['/settings', '/statuses', '/presets', '/schedules', '/epics'].some(p => w.path.startsWith(p)))) expect(w.workspace, w.path).toBe('work')
        expect(report.people).toEqual(['Ada'])
        expect(logged[0]).toBe('Made workspace "Work" (work)')
        expect(logged).toContain('Uploaded hub')
        const text = summary(report)
        expect(text).toContain('http://home')
        expect(text).toContain('Ada')
    })

    it('takes a named tint as the colour, and none it can’t read', async () => {
        for (const [tint, color] of [['teal', 'teal'], ['plaid', undefined]] as const) {
            const from = source()
            const to = target()
            const settings = await from.get('/settings')
            from.get = (async (path: string, options?: Options) => path === '/settings' ? {...settings, tint} : source().get(path, options)) as typeof from.get
            await importOrrery({source: from, target: to, name: 'Work'})
            expect(body(to.writes, 'POST /workspaces')).toEqual({name: 'Work', ...color ? {color} : {}})
        }
    })
})

describe('importOrrery, adding to a workspace', () => {
    const target = () => fake('http://home', {
        '/workspaces': [{id: 'work', name: 'Work'}],
        '/projects': [],
        '/projects@work': [],
        '/people': [{id: 'ada', name: 'Ada Lovelace'}],
        '/statuses@work': [{id: 'w-todo', name: 'Todo', kind: 'todo'}, {id: 'w-doing', name: 'Doing', kind: 'started'}],
        '/presets@work': [{id: 1, name: 'Reviewer', text: 'Review it, closely', default: {key: 'review'}}, {id: 3, name: 'Planner', text: 'p', default: {key: 'plan'}}, {id: 4, name: 'Mine', text: 'm'}],
        '/projects/hub/schedules': [{id: 40, presets: []}, {id: 41, presets: []}],
        '/schedules/across@work': [{id: 70, title: 'Nightly'}],
        '/epics@work': [{id: 700, title: 'Spring'}, {id: 701, title: 'Summer'}],
    }, {
        'UPLOAD /projects/upload?id=kit': () => {
            throw new Error('413 Payload Too Large')
        },
        'UPLOAD /projects/upload': (_, path) => {
            const query = new URL(path, 'http://x').searchParams
            return {id: query.get('id'), key: query.get('key')}
        },
        'POST /uploads': () => {
            throw new Error('no room')
        },
        'PATCH /projects/hub/issues': () => {
            throw new Error('409 it moved')
        },
        'POST /statuses': () => ({}),
    })

    it("keeps the workspace's own, carries on past a board that fails, and notes what didn't take", async () => {
        const to = target()
        const logged: string[] = []
        const report = await importOrrery({source: source(), target: to, name: 'work', add: true, log: (line: string) => logged.push(line)})
        const lines = said(to.writes)

        expect(lines).not.toContain('POST /workspaces')
        expect(logged[0]).toBe('Adding to workspace "Work" (work)')
        // Its statuses stay: one is made for Review only if it has none of that name and kind.
        expect(lines.filter(l => l.startsWith('DELETE /statuses'))).toEqual([])
        expect(body(to.writes, 'POST /statuses')).toMatchObject({name: 'Review', kind: 'started'})
        // Its presets stay, nothing restored or removed, and the same text isn't written again.
        expect(lines).not.toContain('POST /presets/defaults')
        expect(lines.filter(l => l.startsWith('DELETE /presets'))).toEqual([])
        expect(lines.filter(l => l.startsWith('PATCH /presets'))).toEqual(['PATCH /presets/1'])
        expect(report.presets).toEqual({made: 0, shipped: 2, removed: 0})

        // The image that wouldn't go is said, and the board still goes; the board that fails is said, and the rest goes on.
        expect(logged).toContain(`Couldn't send image ${IMAGE}: no room`)
        expect(report.projects.find((p: {id: string}) => p.id === 'kit').error).toBe('413 Payload Too Large')
        expect(logged).toContain("Couldn't upload kit: 413 Payload Too Large")
        // So hub's link to kit goes, the rest of its links are put back, and what the target refuses is noted, not thrown.
        expect(to.writes.filter(w => w.path === '/projects/hub/issues/HUB-1').map(w => w.body)).toEqual([{depends_on: ['HUB-2']}, {epic: 700}])
        expect(report.notes).toEqual(["hub/HUB-1's links: 409 it moved", "hub/HUB-1's epic: 409 it moved"])

        // The schedule across projects it has already isn't made again, and none is turned on unless asked.
        expect(lines).not.toContain('POST /schedules')
        expect(report.across).toEqual({made: 0})
        expect(report.schedules).toEqual({enabled: false, wasOn: ['hub: Groom', 'across: Nightly'], turnedOn: 0})
        // Its epics of the same title are used, not made again.
        expect(lines).not.toContain('POST /epics')
        expect(report.epics).toEqual({made: 0, comments: 0, issues: 1})
        // Someone the target knows by id, under another name, isn't missing; one it doesn't know is.
        expect(report.people).toEqual(['Sköll'])
    })

    it('notes a schedule across projects it could not make, and skips one with no project left', async () => {
        const from = source()
        const across = [
            {id: 5, title: 'Nightly', enabled: 0, projects: ['hub']},
            {id: 6, title: 'Weekly', enabled: 0, projects: ['gone']},
            {id: 7, title: 'Everywhere', enabled: 0, projects: '*'},
        ]
        const read = from.get
        from.get = (async (path: string, options?: Options) => path === '/schedules/across' ? across : read(path, options)) as typeof from.get
        const to = fake('http://home', {
            '/workspaces': [], '/projects': [], '/people': [],
            '/statuses@work': [], '/settings': {}, '/presets@work': [],
            '/projects/hub/schedules': [], '/projects/kit/schedules': [],
        }, {
            'POST /workspaces': () => ({id: 'work', name: 'Work'}),
            'POST /presets/defaults': () => [],
            'POST /presets': () => ({id: 101}),
            'POST /epics/': () => ({}),
            'POST /epics': () => ({id: 600}),
            'UPLOAD /projects/upload': (_, path) => ({id: new URL(path, 'http://x').searchParams.get('id')}),
            'POST /schedules': (sent) => {
                if ((sent as {title: string}).title === 'Nightly') throw new Error('400 bad cron')
                return {id: 78}
            },
        })
        const report = await importOrrery({source: from, target: to, name: 'Work'})
        expect(report.notes).toContain('schedule across projects "Nightly": 400 bad cron')
        expect(to.writes.filter(w => w.path === '/schedules').map(w => (w.body as {title: string, projects: unknown}).projects)).toEqual([['hub'], '*'])
        expect(report.across).toEqual({made: 1})
    })
})

describe('client', () => {
    function fetching(reply: {status?: number, text?: string, bytes?: number[]}) {
        const asked: {url: string, init: RequestInit}[] = []
        const fetch = (async (url: string, init: RequestInit) => {
            asked.push({url, init})
            const status = reply.status ?? 200
            return {
                ok: status < 400, status,
                text: async () => reply.text ?? '',
                arrayBuffer: async () => new Uint8Array(reply.bytes ?? []).buffer,
            }
        }) as unknown as typeof globalThis.fetch
        return {asked, fetch}
    }

    it('sends its key, the person, the workspace and JSON, to the address without its trailing slashes', async () => {
        const {asked, fetch} = fetching({text: '{"id":"hub"}'})
        const api = client('http://home//', {key: 'k1', person: 'ada', fetch})
        expect(api.url).toBe('http://home')
        await expect(api.post('/projects', {name: 'Hub'}, {workspace: 'work'})).resolves.toEqual({id: 'hub'})
        expect(asked[0]!.url).toBe('http://home/api/projects')
        expect(asked[0]!.init).toEqual({method: 'POST', body: '{"name":"Hub"}', headers: {
            'Authorization': 'Bearer k1', 'Orrery-Actor': 'ada', 'Orrery-Person': 'ada', 'Orrery-Workspace': 'work', 'Content-Type': 'application/json',
        }})
    })

    it('sends no headers it has nothing for, and each method as named', async () => {
        const {asked, fetch} = fetching({text: ''})
        const api = client('http://home', {fetch})
        await expect(api.get('/a')).resolves.toBeNull()
        await api.patch('/b', {x: 1})
        await api.del('/c')
        await api.upload('/d', '{"raw":true}')
        expect(asked.map(a => [a.init.method, a.init.body])).toEqual([['GET', undefined], ['PATCH', '{"x":1}'], ['DELETE', undefined], ['POST', '{"raw":true}']])
        expect(asked[0]!.init.headers).toEqual({})
    })

    it('reads a body that is not JSON as its text, and bytes as base64', async () => {
        await expect(client('http://h', {fetch: fetching({text: '<!DOCTYPE html>'}).fetch}).get('/workspaces')).resolves.toBe('<!DOCTYPE html>')
        await expect(client('http://h', {fetch: fetching({bytes: [65, 66, 67]}).fetch}).bytes('/uploads/x')).resolves.toBe('QUJD')
    })

    it('throws with the status and what the server said: its message, its status message, or its text', async () => {
        for (const [text, said] of [['{"message":"No such project"}', 'No such project'], ['{"statusMessage":"Not Found"}', 'Not Found'], ['gateway down', 'gateway down']]) {
            const api = client('http://h', {fetch: fetching({status: 404, text}).fetch})
            await expect(api.get('/projects/x')).rejects.toMatchObject({message: `GET /projects/x: 404 ${said}`, status: 404})
        }
        // A failed read of bytes says why too.
        await expect(client('http://h', {fetch: fetching({status: 403, text: '{"message":"Not yours"}'}).fetch}).bytes('/uploads/x')).rejects.toThrow('GET /uploads/x: 403 Not yours')
    })
})
