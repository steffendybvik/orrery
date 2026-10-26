import {describe, expect, it} from 'vitest'
// @ts-expect-error: the channel is plain JavaScript, run by node from other repos
import {TOOLS, orreryTools} from '../../channel/tools.mjs'

type Call = {method: string, url: string, headers: Record<string, string>, body?: unknown}

/** The tools against a pretend Orrery: `answers` by `METHOD path`, every call kept. */
function harness(answers: Record<string, {status?: number, body: unknown}>) {
    const calls: Call[] = []
    const fetch = async (url: string, init: {method: string, headers: Record<string, string>, body?: string}) => {
        const path = url.replace('http://o/api/projects/larder', '').replace('http://o/api', '')
        calls.push({method: init.method, url: path, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined})
        const answer = answers[`${init.method} ${path.split('?')[0]}`] ?? {status: 404, body: {message: `No ${path}`}}
        const status = answer.status ?? 200
        return {ok: status < 400, status, statusText: '', text: async () => JSON.stringify(answer.body)}
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
        expect(TOOLS.map((t: {name: string}) => t.name)).toEqual(['issues', 'issue', 'create_issue', 'update_issue', 'start_issue', 'finish_issue', 'comment', 'chunks', 'releases', 'docs', 'doc', 'write_doc', 'secrets', 'egress'])
        for (const tool of TOOLS) expect(tool).toMatchObject({description: expect.any(String), inputSchema: {type: 'object'}})
    })

    it('write as claude, from the session', async () => {
        const {calls, call} = harness({'PATCH /issues/LAR-1': {body: issue({status: 'in-progress', assignee: 'claude'})}, 'POST /issues/LAR-1/comments': {body: {id: 7}}})
        expect(await call('start_issue', {id: 'LAR-1', comment: 'On it'})).toEqual({error: false, text: 'Started LAR-1 [in-progress, claude] Shelves'})
        expect(calls.map(c => [c.method, c.url, c.body])).toEqual([['PATCH', '/issues/LAR-1', {status: 'started', assignee: 'claude'}], ['POST', '/issues/LAR-1/comments', {body: 'On it'}]])
        expect(calls[0]!.headers).toMatchObject({'Orrery-Actor': 'claude', 'Orrery-Session': 'abc'})
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

    it('make a proposal, and finish with a comment first', async () => {
        const {call, calls} = harness({'POST /issues': {body: issue({proposal: 'pending'})}, 'POST /issues/LAR-1/comments': {body: {id: 1}}, 'PATCH /issues/LAR-1': {body: issue({status: 'in-review'})}})
        await call('create_issue', {title: 'Shelves', proposal: true})
        expect(calls[0]!.body).toEqual({title: 'Shelves', proposal: 'pending'})
        expect((await call('finish_issue', {id: 'LAR-1', comment: 'Built', status: 'in-review'})).text).toBe('In review: LAR-1 [in-review] Shelves')
        expect(calls.slice(1).map(c => c.method)).toEqual(['POST', 'PATCH'])
    })

    it('list the releases, and the issues in one', async () => {
        const kinds = {proposed: 0, backlog: 1, todo: 0, started: 0, done: 2, canceled: 0}
        const {call, calls} = harness({
            'GET /releases': {body: [{version: '1.1.0', branch: 'v1.1.0', issues: 3, kinds}, {version: '1.0.0', shipped_on: '2026-10-01', issues: 1, kinds: {...kinds, backlog: 0, done: 1}}]},
            'GET /issues': {body: []},
        })
        expect((await call('releases')).text).toBe('1.1.0 on v1.1.0: 3 issues, 2/3 done\n1.0.0 (shipped 2026-10-01): 1 issue, 1/1 done')
        await call('issues', {release: '1.1.0'})
        expect(calls[1]!.url).toBe('/issues?release=1.1.0')
    })

    it("say Orrery's reason when it refuses", async () => {
        const {call} = harness({'PATCH /issues/LAR-1': {status: 400, body: {message: '"status" is "soon"'}}})
        expect(await call('update_issue', {id: 'LAR-1', status: 'soon'})).toEqual({error: true, text: 'Orrery said no: "status" is "soon"'})
        expect((await call('nope')).error).toBe(true)
    })
})
