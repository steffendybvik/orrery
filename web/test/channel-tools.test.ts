import {describe, expect, it} from 'vitest'
// @ts-expect-error: the channel is plain JavaScript, run by node from other repos
import {TOOLS, orreryTools, toolsFor} from '../../channel/tools.mjs'

type Call = {method: string, url: string, headers: Record<string, string>, body?: unknown}

/** The tools against a pretend Orrery: `answers` by `METHOD path` (`raw` for a body that isn't JSON), every call kept. */
function harness(answers: Record<string, {status?: number, body?: unknown, raw?: string}>) {
    const calls: Call[] = []
    const fetch = async (url: string, init: {method: string, headers: Record<string, string>, body?: string}) => {
        const path = url.replace('http://o/api/projects/larder', '').replace('http://o/api', '')
        calls.push({method: init.method, url: path, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined})
        const answer = answers[`${init.method} ${path.split('?')[0]}`] ?? {status: 404, body: {message: `No ${path}`}}
        const status = answer.status ?? 200
        return {ok: status < 400, status, statusText: '', text: async () => answer.raw ?? JSON.stringify(answer.body)}
    }
    const call = orreryTools({api: 'http://o/api/projects/larder', session: 'abc', fetch}) as (name: string, args?: object) => Promise<{isError?: boolean, content: {text: string}[]}>
    return {calls, call: async (name: string, args?: object) => {
        const result = await call(name, args)
        return {error: !!result.isError, text: result.content[0]!.text}
    }}
}

const issue = (fields: object = {}) => ({id: 'LAR-1', title: 'Shelves', status: 'todo', kind: 'todo', tasks: [], counts: {}, kinds: {}, ...fields})

describe("the channel's tools", () => {
    it('each have a name, a description and an object schema', () => {
        expect(TOOLS.map((t: {name: string}) => t.name)).toEqual(['issues', 'issue', 'create_issue', 'update_issue', 'start_issue', 'finish_issue', 'comment', 'chunks', 'releases', 'docs', 'doc', 'write_doc', 'presets', 'preset', 'write_preset', 'secrets', 'egress', 'events', 'resolve_event'])
        for (const tool of TOOLS) expect(tool).toMatchObject({description: expect.any(String), inputSchema: {type: 'object'}})
    })

    it('write as claude, from the session', async () => {
        const {calls, call} = harness({'PATCH /issues/LAR-1': {body: issue({status: 'in-progress', assignee: 'claude'})}, 'POST /issues/LAR-1/comments': {body: {id: 7}}})
        expect(await call('start_issue', {id: 'LAR-1', comment: 'On it'})).toEqual({error: false, text: 'Started LAR-1 [in-progress, claude] Shelves'})
        expect(calls.map(c => [c.method, c.url, c.body])).toEqual([['PATCH', '/issues/LAR-1', {status: 'started', assignee: 'claude'}], ['POST', '/issues/LAR-1/comments', {body: 'On it'}]])
        expect(calls[0]!.headers).toMatchObject({'Orrery-Actor': 'claude', 'Orrery-Session': 'abc'})
    })

    it('read presets and write them, new or changed, as the owner asks', async () => {
        const release = {id: 3, project: 'larder', name: 'Release', text: 'Cut the release.\nThen tag it.'}
        const {calls, call} = harness({
            'GET /presets': {body: [{id: 1, project: null, name: 'Review', text: 'Read the diff.'}, release]},
            'GET /presets/3': {body: release},
            'POST /presets': {body: {...release, id: 4, name: 'Audit'}},
            'PATCH /presets/3': {body: release},
        })
        expect((await call('presets')).text).toBe("1: Review (the Orrery's) — Read the diff.\n3: Release (larder) — Cut the release.")
        expect((await call('preset', {id: 3})).text).toBe('# Release (larder)\n\nCut the release.\nThen tag it.')
        expect((await call('write_preset', {name: 'Audit', text: 'Audit it.'})).text).toBe('Saved the preset 4: Audit (larder).')
        expect((await call('write_preset', {id: 3, text: 'Cut it.'})).text).toBe('Saved the preset 3: Release (larder).')
        expect(calls.slice(2).map(c => [c.method, c.url, c.body])).toEqual([['POST', '/presets', {name: 'Audit', text: 'Audit it.'}], ['PATCH', '/presets/3', {text: 'Cut it.'}]])
    })

    it("read the Orrery's event log and resolve what they fixed", async () => {
        const event = {id: 4, level: 'error', kind: 'page.error', message: 'x is undefined', details: {page: '/mine', stack: 'at setup'}, count: 3, first_seen: '2026-10-27T20:00:00Z', last_seen: '2026-10-27T20:05:00Z'}
        const {calls, call} = harness({'GET /events/log': {body: [event]}, 'POST /events/log/4/resolve': {body: {...event, resolved_at: '2026-10-27T21:00:00Z'}}})
        expect((await call('events', {level: 'error', open: true})).text).toBe('#4 [error] page.error ×3, last 2026-10-27T20:05:00Z: x is undefined')
        expect(calls[0]?.url).toBe('/events/log?level=error&open=1&limit=30')
        expect((await call('events', {details: true})).text).toContain('"stack": "at setup"')
        expect((await call('resolve_event', {id: 4})).text).toBe('Resolved #4 page.error: x is undefined')
    })

    it("call outside services through the Orrery's egress, for their project", async () => {
        const {call, calls} = harness({
            'GET /secrets': {body: [{name: 'STRIPE_KEY', hosts: ['api.stripe.com'], projects: null}, {name: 'GH', hosts: ['api.github.com'], projects: ['larder']}]},
            'POST /egress': {body: {status: 200, headers: {'content-type': 'application/json'}, body: '{"ok":true}', secrets: ['STRIPE_KEY']}},
        })
        expect((await call('secrets')).text).toBe('STRIPE_KEY → api.stripe.com\nGH → api.github.com (only larder)')
        const request = {url: 'https://api.stripe.com/v1/charges', headers: {Authorization: 'Bearer {{secret:STRIPE_KEY}}'}, issue: 'LAR-1'}
        expect((await call('egress', request)).text).toBe('200 (application/json)\n\n{"ok":true}')
        expect(calls[1]).toMatchObject({method: 'POST', url: '/egress', body: {...request, project: 'larder'}})
    })

    it('list the open issues unless asked for a status', async () => {
        const {call, calls} = harness({'GET /issues': {body: [issue(), issue({id: 'LAR-2', title: 'Old', status: 'done', kind: 'done'})]}})
        expect((await call('issues')).text).toBe('LAR-1 [todo] Shelves')
        expect((await call('issues', {status: 'done', q: 'old'})).text).toContain('LAR-2')
        expect(calls[1]!.url).toBe('/issues?status=done&q=old')
    })

    it('make a proposal, and finish with the status first, then the comment', async () => {
        const {call, calls} = harness({'POST /issues': {body: issue({proposal: 'pending'})}, 'POST /issues/LAR-1/comments': {body: {id: 1}}, 'PATCH /issues/LAR-1': {body: issue({status: 'in-review'})}})
        await call('create_issue', {title: 'Shelves', proposal: true})
        expect(calls[0]!.body).toEqual({title: 'Shelves', proposal: 'pending'})
        expect((await call('finish_issue', {id: 'LAR-1', comment: 'Built', status: 'in-review'})).text).toBe('In review: LAR-1 [in-review] Shelves')
        expect(calls.slice(1).map(c => c.method)).toEqual(['PATCH', 'POST'])
    })

    it('leave no comment when finishing is refused', async () => {
        const {call, calls} = harness({'PATCH /issues/LAR-1': {status: 403, body: {message: 'Not yours'}}, 'POST /issues/LAR-1/comments': {body: {id: 1}}})
        expect(await call('finish_issue', {id: 'LAR-1', comment: 'Built'})).toEqual({error: true, text: 'Orrery said no: Not yours'})
        expect(calls.map(c => c.method)).toEqual(['PATCH'])
    })

    it("say the status when what answers isn't Orrery", async () => {
        const {call} = harness({'GET /issues': {status: 502, raw: '<html>Bad Gateway</html>'}})
        expect(await call('issues')).toEqual({error: true, text: "Orrery said no: 502, not an answer from Orrery"})
    })

    it('list the releases, and the issues in one', async () => {
        const kinds = {proposed: 0, backlog: 1, todo: 0, started: 0, done: 2, canceled: 0}
        const {call, calls} = harness({
            'GET /releases': {body: [{version: '1.1.0', branch: 'v1.1.0', frozen_on: '2026-10-20', issues: 3, kinds}, {version: '1.0.0', shipped_on: '2026-10-01', issues: 1, kinds: {...kinds, backlog: 0, done: 1}}]},
            'GET /issues': {body: []},
        })
        expect((await call('releases')).text).toBe('1.1.0 (feature freeze since 2026-10-20: fixes, tests and docs) on v1.1.0: 3 issues, 2/3 done\n1.0.0 (shipped 2026-10-01): 1 issue, 1/1 done')
        await call('issues', {release: '1.1.0'})
        expect(calls[1]!.url).toBe('/issues?release=1.1.0')
    })

    it("say Orrery's reason when it refuses", async () => {
        const {call} = harness({'PATCH /issues/LAR-1': {status: 400, body: {message: '"status" is "soon"'}}})
        expect(await call('update_issue', {id: 'LAR-1', status: 'soon'})).toEqual({error: true, text: 'Orrery said no: "status" is "soon"'})
        expect((await call('nope')).error).toBe(true)
    })
})

describe('one channel serving several projects', () => {
    /** The tools on larder (LAR) and pantry (PAN) at a pretend Orrery: `answers` by `METHOD path` under /api. */
    function several(answers: Record<string, unknown>) {
        const calls: Call[] = []
        const fetch = async (url: string, init: {method: string, headers: Record<string, string>, body?: string}) => {
            const path = url.replace('http://o/api', '')
            calls.push({method: init.method, url: path, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined})
            const body = answers[`${init.method} ${path.split('?')[0]}`]
            return {ok: body !== undefined, status: body === undefined ? 404 : 200, statusText: '', text: async () => JSON.stringify(body ?? {message: `No ${path}`})}
        }
        const call = orreryTools({root: 'http://o/api', projects: ['larder', 'pantry'], session: 'abc', fetch}) as (name: string, args?: object) => Promise<{isError?: boolean, content: {text: string}[]}>
        return {calls, call: async (name: string, args?: object) => {
            const result = await call(name, args)
            return {error: !!result.isError, text: result.content[0]!.text}
        }}
    }
    const projects = [{id: 'larder', key: 'LAR'}, {id: 'pantry', key: 'PAN'}, {id: 'garden', key: 'GAR'}]

    it("find an issue's project from its id's key", async () => {
        const {call, calls} = several({'GET /projects': projects, 'PATCH /projects/pantry/issues/PAN-3': issue({id: 'PAN-3', status: 'in-review'}), 'POST /projects/pantry/issues/PAN-3/comments': {id: 1}})
        expect((await call('finish_issue', {id: 'PAN-3', comment: 'Built', status: 'in-review'})).text).toBe('In review: PAN-3 [in-review] Shelves')
        expect(calls.map(c => c.url)).toEqual(['/projects', '/projects/pantry/issues/PAN-3', '/projects/pantry/issues/PAN-3/comments'])
        // A key of a project it doesn't serve is refused, saying which it does.
        expect((await call('issue', {id: 'GAR-1'})).text).toBe("Orrery said no: GAR-1 isn't an issue of larder, pantry: its key is none of theirs")
    })

    it('take the project for the others, refusing none or one it doesn\'t serve', async () => {
        const {call, calls} = several({'GET /projects/larder/docs': [{id: 'stack', title: 'The stack'}]})
        expect((await call('docs', {project: 'larder'})).text).toBe('stack: The stack')
        expect(calls[0]!.url).toBe('/projects/larder/docs')
        expect((await call('docs')).text).toBe('Orrery said no: Say which project: larder, pantry')
        expect((await call('docs', {project: 'garden'})).text).toBe('Orrery said no: This server serves larder, pantry, not garden')
    })

    it("write a new preset for one project, or with orrery for every project's sessions", async () => {
        const {call, calls} = several({'POST /projects/pantry/presets': {id: 5, project: 'pantry', name: 'Jars', text: 'x'}, 'POST /presets': {id: 6, project: null, name: 'Audit', text: 'y'}})
        expect((await call('write_preset', {project: 'pantry', name: 'Jars', text: 'x'})).text).toBe('Saved the preset 5: Jars (pantry).')
        expect((await call('write_preset', {orrery: true, name: 'Audit', text: 'y'})).text).toBe("Saved the preset 6: Audit (the Orrery's).")
        expect((await call('write_preset', {name: 'Jars', text: 'x'})).text).toBe('Orrery said no: Say which project: larder, pantry')
        expect(calls.map(c => c.url)).toEqual(['/projects/pantry/presets', '/presets'])
    })

    it('list the project argument, required, on the tools that work on one project', () => {
        const tools = toolsFor(['larder', 'pantry']) as {name: string, inputSchema: {required?: string[], properties: Record<string, {enum?: string[]}>}}[]
        const docs = tools.find(t => t.name === 'docs')!
        expect(docs.inputSchema.required).toEqual(['project'])
        expect(docs.inputSchema.properties.project!.enum).toEqual(['larder', 'pantry'])
        expect(tools.find(t => t.name === 'issue')!.inputSchema.properties).not.toHaveProperty('project')
        expect(toolsFor(['larder'])).toBe(TOOLS)
    })
})
