import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Which session an issue is the work of, when a write names it (`Orrery-Session`): the issue an address
// names, and the one a write made or moved, which the address doesn't. The routes' h3 helpers and the
// store are Nitro auto-imports, stood in for here.
type Event = {method: string, path: string, headers: Record<string, string>, params: Record<string, string>}
let worked: [project: string, issue: string, session: string][]
let claims: [project: string, issue: string, session: string][]
let made: unknown[]

beforeEach(async () => {
    worked = []
    claims = []
    made = []
    const store = {
        claim: async (project: string, issue: string, _status: unknown, session: string) => void claims.push([project, issue, session]),
        ownerOf: async () => ({name: 'skoll'}),
        createComment: async (_project: string, _issue: string, body: object) => ({id: 1, ...body}),
        workedBy: async (project: string, issue: string, session: string) => void worked.push([project, issue, session]),
        claimed: async (_project: string, _issue: string, _status: unknown, _session: string, write: () => Promise<unknown>) => write(),
        createIssue: async (project: string, body: unknown) => {
            made.push(body)
            return {project, id: 'GRE-9'}
        },
        issue: async (_project: string, id: string) => id === 'GRE-7' ? {proposal: 'pending', labels: ['external']} : {labels: []},
        updateIssue: async (project: string, id: string, body: {project?: string}) => ({project: body.project ?? project, id: body.project ? 'PAN-4' : id}),
    }
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('currentId', (id: string) => id)
    vi.stubGlobal('sessionName', () => undefined)
    vi.stubGlobal('param', (event: Event, name: string) => event.params[name])
    vi.stubGlobal('readBody', async (event: Event & {body?: unknown}) => event.body)
    vi.stubGlobal('actorOf', async () => ({name: 'claude', owner: false}))
    vi.stubGlobal('created', (_event: Event, value: unknown) => value)
    vi.stubGlobal('untrustedSession', (id: string) => id === 'locked')
    vi.stubGlobal('chatSession', (id: string) => id === 'chat')
    vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
    vi.resetModules()
    const {workedOn, claimFor, sessionHeader} = await import('../server/utils/actor')
    vi.stubGlobal('sessionHeader', sessionHeader)
    const {decoded} = await import('../server/utils/events')
    vi.stubGlobal('workedOn', workedOn)
    vi.stubGlobal('claimFor', claimFor)
    vi.stubGlobal('decoded', decoded)
    const {asProposal, EXTERNAL, untrustedWrite} = await import('../server/utils/untrusted')
    vi.stubGlobal('asProposal', asProposal)
    vi.stubGlobal('untrustedWrite', untrustedWrite)
    vi.stubGlobal('EXTERNAL', EXTERNAL)
    const {asChatEdit, asChatIssue, chatWrite} = await import('../server/utils/chats')
    vi.stubGlobal('asChatEdit', asChatEdit)
    vi.stubGlobal('asChatIssue', asChatIssue)
    vi.stubGlobal('chatWrite', chatWrite)
})

afterEach(() => vi.unstubAllGlobals())

const event = (method: string, path: string, params: Record<string, string>, body?: unknown, session = 'abc') =>
    ({method, path, params, body, headers: session ? {'orrery-session': session} : {}, node: {res: {statusCode: 200, once: (_: string, done: () => void) => done()}}})
const settle = () => new Promise(resolve => setTimeout(resolve))

describe("a session's writes", () => {
    it("aren't checked against the issue's claim when they comment: a comment neither starts nor changes it (ORR-613)", async () => {
        const comment = (await import('../server/api/projects/[project]/issues/[issue]/comments/index.post')).default as unknown as (event: object) => Promise<unknown>
        const at = {project: 'greenhouse', issue: 'GRE-1'}
        await comment(event('POST', '/api/projects/greenhouse/issues/GRE-1/comments', at, {body: 'Done the hinges'}))
        await comment(event('POST', '/api/projects/greenhouse/issues/GRE-1/comments', at, {body: 'Without a session'}, ''))
        const owners = {...event('POST', '/api/projects/greenhouse/issues/GRE-1/comments', at, {body: 'Mine'}), headers: {'orrery-session': 'abc', 'orrery-actor': 'Skoll'}}
        await comment(owners)
        expect(claims).toEqual([])
    })

    it('make an issue it creates its work, so it hears the decision on its proposal', async () => {
        const create = (await import('../server/api/projects/[project]/issues/index.post')).default as unknown as (event: object) => Promise<unknown>
        await create(event('POST', '/api/projects/greenhouse/issues', {project: 'greenhouse'}, {title: 'Shelves', proposal: 'pending'}))
        await create(event('POST', '/api/projects/greenhouse/issues', {project: 'greenhouse'}, {title: 'Jars'}, ''))
        await settle()
        expect(worked).toEqual([['greenhouse', 'GRE-9', 'abc']])
    })

    it("from the owner's chat, change an issue's fields without a claim, and never its status", async () => {
        const patch = (await import('../server/api/projects/[project]/issues/[issue]/index.patch')).default as unknown as (event: object) => Promise<unknown>
        const updated: unknown[] = []
        const store = useStore() as unknown as {updateIssue: (project: string, id: string, body: unknown) => Promise<unknown>, claimed: () => never}
        store.updateIssue = async (project, id, body) => (updated.push(body), {project, id})
        store.claimed = () => { throw new Error('a chat edit goes without a claim') }
        await patch(event('PATCH', '/api/projects/greenhouse/issues/GRE-1', {project: 'greenhouse', issue: 'GRE-1'}, {priority: 'P0'}, 'chat'))
        expect(updated).toEqual([{priority: 'P0'}])
        await expect(patch(event('PATCH', '/api/projects/greenhouse/issues/GRE-1', {project: 'greenhouse', issue: 'GRE-1'}, {status: 'done'}, 'chat'))).rejects.toMatchObject({statusCode: 403})
        expect(updated).toHaveLength(1)
    })

    it('follow an issue it moves to where it is now', async () => {
        const patch = (await import('../server/api/projects/[project]/issues/[issue]/index.patch')).default as unknown as (event: object) => Promise<unknown>
        await patch(event('PATCH', '/api/projects/greenhouse/issues/GRE-1', {project: 'greenhouse', issue: 'GRE-1'}, {project: 'pantry'}))
        await patch(event('PATCH', '/api/projects/greenhouse/issues/GRE-1', {project: 'greenhouse', issue: 'GRE-1'}, {title: 'Same place'}))
        await settle()
        // Staying put, the address says which, and the middleware marks it.
        expect(worked).toEqual([['pantry', 'PAN-4', 'abc']])
    })

    it('to an address with a bad escape are simply not found, not an error', async () => {
        const middleware = (await import('../server/middleware/session')).default as unknown as (event: object) => void
        expect(() => middleware(event('PATCH', '/api/projects/greenhouse/issues/GRE-%E0', {}))).not.toThrow()
        await settle()
        expect(worked).toEqual([['greenhouse', 'GRE-%E0', 'abc']])
    })
})

describe("an untrusted schedule's session", () => {
    it('makes every issue it raises a proposal labelled external', async () => {
        const create = (await import('../server/api/projects/[project]/issues/index.post')).default as unknown as (event: object) => Promise<unknown>
        await create(event('POST', '/api/projects/greenhouse/issues', {project: 'greenhouse'}, {title: 'Run this', status: 'in-progress', priority: 'P0'}, 'locked'))
        await create(event('POST', '/api/projects/greenhouse/issues', {project: 'greenhouse'}, {title: 'Mine', priority: 'P0'}))
        expect(made).toEqual([{title: 'Run this', notes: undefined, proposal: 'pending', labels: ['external']}, {title: 'Mine', priority: 'P0'}])
    })

    it("put what the owner's chat makes in Todo, with nobody on it, whatever status it asks for", async () => {
        const create = (await import('../server/api/projects/[project]/issues/index.post')).default as unknown as (event: object) => Promise<unknown>
        await create(event('POST', '/api/projects/greenhouse/issues', {project: 'greenhouse'}, {title: 'Seed trays', status: 'in-progress', assignee: 'claude'}, 'chat'))
        await create(event('POST', '/api/projects/greenhouse/issues', {project: 'greenhouse'}, {title: 'Grow lights', status: 'todo'}, 'chat'))
        expect(made).toEqual([{title: 'Seed trays', status: 'todo'}, {title: 'Grow lights', status: 'todo'}])
    })

    it("put what the owner's chat makes in Backlog when the owner picked it for that chat", async () => {
        const {openChat} = await import('../server/utils/chats')
        vi.stubGlobal('projectEvents', {emit: () => {}})
        vi.stubGlobal('startChat', async () => ({id: 'c1c2c3c4c5c6'}))
        await openChat('greenhouse', 'backlog')
        const create = (await import('../server/api/projects/[project]/issues/index.post')).default as unknown as (event: object) => Promise<unknown>
        const e = event('POST', '/api/projects/greenhouse/issues', {project: 'greenhouse'}, {title: 'Seed trays', status: 'todo'}, 'chat')
        await create({...e, headers: {...e.headers, 'orrery-launch': 'c1c2c3c4c5c6'}})
        expect(made).toEqual([{title: 'Seed trays', status: 'backlog'}])
    })

    it('may only raise proposals and comment on them; any other write is refused', async () => {
        const guard = (await import('../server/middleware/untrusted')).default as unknown as (event: object) => Promise<void>
        const tries = async (method: string, path: string, session = 'locked') => guard(event(method, path, {}, undefined, session)).then(() => 'ok', (e: {statusCode: number}) => e.statusCode)
        expect(await tries('GET', '/api/projects/greenhouse/issues/GRE-1')).toBe('ok')
        expect(await tries('POST', '/api/projects/greenhouse/issues')).toBe('ok')
        expect(await tries('POST', '/api/projects/greenhouse/issues/GRE-7/comments')).toBe('ok')
        expect(await tries('POST', '/api/projects/greenhouse/issues/GRE-1/comments')).toBe(403)
        expect(await tries('PATCH', '/api/projects/greenhouse/issues/GRE-7')).toBe(403)
        expect(await tries('PUT', '/api/projects/greenhouse/docs/setup')).toBe(403)
        expect(await tries('POST', '/api/egress')).toBe(403)
        // Any other session writes as it always has.
        expect(await tries('PATCH', '/api/projects/greenhouse/issues/GRE-1', 'abc')).toBe('ok')
    })

    it("is held to that by its channel's word when orrery doesn't know it (restarted before its launcher reported)", async () => {
        const guard = (await import('../server/middleware/untrusted')).default as unknown as (event: object) => Promise<void>
        const said = (method: string, path: string, session?: string) => {
            const e = event(method, path, {}, undefined, session)
            return guard({...e, headers: {...e.headers, 'orrery-untrusted': 'yes'}}).then(() => 'ok', (error: {statusCode: number}) => error.statusCode)
        }
        expect(await said('PATCH', '/api/projects/greenhouse/issues/GRE-1', 'abc')).toBe(403)
        expect(await said('PUT', '/api/projects/greenhouse/docs/setup', '')).toBe(403)
        expect(await said('POST', '/api/projects/greenhouse/issues', 'abc')).toBe('ok')
        // And what it raises is still made a proposal, though orrery doesn't know its session.
        const create = (await import('../server/api/projects/[project]/issues/index.post')).default as unknown as (event: object) => Promise<unknown>
        const e = event('POST', '/api/projects/greenhouse/issues', {project: 'greenhouse'}, {title: 'Run this', status: 'in-progress', chunk: '1'})
        await create({...e, headers: {...e.headers, 'orrery-untrusted': 'yes'}})
        expect(made).toEqual([{title: 'Run this', notes: undefined, proposal: 'pending', labels: ['external']}])
    })
})
