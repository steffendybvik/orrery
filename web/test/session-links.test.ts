import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Which session an issue is the work of, when a write names it (`Orrery-Session`): the issue an address
// names, and the one a write made or moved, which the address doesn't. The routes' h3 helpers and the
// store are Nitro auto-imports, stood in for here.
type Event = {method: string, path: string, headers: Record<string, string>, params: Record<string, string>}
let worked: [project: string, issue: string, session: string][]

beforeEach(async () => {
    worked = []
    const store = {
        workedBy: async (project: string, issue: string, session: string) => void worked.push([project, issue, session]),
        claimed: async (_project: string, _issue: string, _status: unknown, _session: string, write: () => Promise<unknown>) => write(),
        createIssue: async (project: string) => ({project, id: 'LAR-9'}),
        updateIssue: async (project: string, id: string, body: {project?: string}) => ({project: body.project ?? project, id: body.project ? 'PAN-4' : id}),
    }
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('currentId', (id: string) => id)
    vi.stubGlobal('param', (event: Event, name: string) => event.params[name])
    vi.stubGlobal('readBody', async (event: Event & {body?: unknown}) => event.body)
    vi.stubGlobal('actorOf', async () => ({name: 'claude', owner: false}))
    vi.stubGlobal('created', (_event: Event, value: unknown) => value)
    vi.resetModules()
    const {workedOn} = await import('../server/utils/actor')
    const {decoded} = await import('../server/utils/events')
    vi.stubGlobal('workedOn', workedOn)
    vi.stubGlobal('decoded', decoded)
})

afterEach(() => vi.unstubAllGlobals())

const event = (method: string, path: string, params: Record<string, string>, body?: unknown, session = 'abc') =>
    ({method, path, params, body, headers: session ? {'orrery-session': session} : {}, node: {res: {statusCode: 200, once: (_: string, done: () => void) => done()}}})
const settle = () => new Promise(resolve => setTimeout(resolve))

describe("a session's writes", () => {
    it('make an issue it creates its work, so it hears the decision on its proposal', async () => {
        const create = (await import('../server/api/projects/[project]/issues/index.post')).default as unknown as (event: object) => Promise<unknown>
        await create(event('POST', '/api/projects/larder/issues', {project: 'larder'}, {title: 'Shelves', proposal: 'pending'}))
        await create(event('POST', '/api/projects/larder/issues', {project: 'larder'}, {title: 'Jars'}, ''))
        await settle()
        expect(worked).toEqual([['larder', 'LAR-9', 'abc']])
    })

    it('follow an issue it moves to where it is now', async () => {
        const patch = (await import('../server/api/projects/[project]/issues/[issue]/index.patch')).default as unknown as (event: object) => Promise<unknown>
        await patch(event('PATCH', '/api/projects/larder/issues/LAR-1', {project: 'larder', issue: 'LAR-1'}, {project: 'pantry'}))
        await patch(event('PATCH', '/api/projects/larder/issues/LAR-1', {project: 'larder', issue: 'LAR-1'}, {title: 'Same place'}))
        await settle()
        // Staying put, the address says which, and the middleware marks it.
        expect(worked).toEqual([['pantry', 'PAN-4', 'abc']])
    })

    it('to an address with a bad escape are simply not found, not an error', async () => {
        const middleware = (await import('../server/middleware/session')).default as unknown as (event: object) => void
        expect(() => middleware(event('PATCH', '/api/projects/larder/issues/LAR-%E0', {}))).not.toThrow()
        await settle()
        expect(worked).toEqual([['larder', 'LAR-%E0', 'abc']])
    })
})
