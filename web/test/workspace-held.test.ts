import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// A session works in the workspace its calls name (ORR-1109), and the routes this server answers itself hold it there
// as the Rust API's rails do (ORR-1309, `a_session_is_held_to_the_workspace_it_names` in api/src/access/rails_tests.rs):
// one held to `default` that asks to start, stop, watch or send keys to a session on a project in `acme` is refused,
// with a 403 naming both. Its h3 helpers and the store are Nitro auto-imports, stubbed here.
type Event = {method: string, path: string, headers: Record<string, string>}
let middleware: (event: Event) => Promise<void>
const WORKSPACES: Record<string, string> = {primes: 'default', rockets: 'acme'}

const eventOf = (method: string, path: string, headers: Record<string, string> = {}): Event => ({method, path, headers})
const session = (workspace: string) => ({'orrery-session': 's-1', 'orrery-workspace': workspace})

beforeEach(async () => {
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('sessionHeader', (event: Event) => event.headers['orrery-session']?.trim() || undefined)
    vi.stubGlobal('forbidden', (message: string) => Object.assign(new Error(message), {statusCode: 403}))
    vi.stubGlobal('useStore', () => ({
        projectWorkspace: async (id: string) => {
            if (!(id in WORKSPACES)) throw Object.assign(new Error(`No project ${id}`), {statusCode: 404})
            return WORKSPACES[id]
        },
    }))
    const held = await import('../server/utils/workspace-held')
    vi.stubGlobal('heldToWorkspace', held.heldToWorkspace)
    vi.resetModules()
    middleware = (await import('../server/middleware/workspace-held')).default as unknown as typeof middleware
})

afterEach(() => vi.unstubAllGlobals())

const ROUTES: [string, string, string][] = [
    ['start', 'POST', '/api/projects/rockets/launches'],
    ['stop', 'POST', '/api/projects/rockets/launches/abc/stop'],
    ['watch', 'POST', '/api/projects/rockets/launches/abc/watch'],
    ['send keys to', 'POST', '/api/projects/rockets/launches/abc/keys'],
    ['see the screen of', 'GET', '/api/projects/rockets/launches/abc/screen'],
]

describe('a session held to its workspace on the routes this server answers', () => {
    it.each(ROUTES)('refuses one in default that asks to %s a session in acme', async (_what, method, path) => {
        await expect(middleware(eventOf(method, path, session('default')))).rejects.toMatchObject({
            statusCode: 403,
            message: 'This session works in workspace default, and rockets is in acme: start a session there to work on it',
        })
    })

    it.each(ROUTES)('lets one in acme %s a session there', async (_what, method, path) => {
        await expect(middleware(eventOf(method, path, session('acme')))).resolves.toBeUndefined()
    })

    it('reads the project from its encoded name', async () => {
        await expect(middleware(eventOf('POST', '/api/projects/%72ockets/launches', session('default')))).rejects.toMatchObject({statusCode: 403})
    })

    it("holds nobody who isn't a session, or a session naming no workspace", async () => {
        // A page names its address's workspace, but isn't held to it; the launcher names none.
        await expect(middleware(eventOf('POST', '/api/projects/rockets/launches', {'orrery-workspace': 'default'}))).resolves.toBeUndefined()
        await expect(middleware(eventOf('POST', '/api/projects/rockets/launches/abc/claim', {'orrery-launcher': 't'}))).resolves.toBeUndefined()
        await expect(middleware(eventOf('POST', '/api/projects/rockets/launches', {'orrery-session': 's-1'}))).resolves.toBeUndefined()
        await expect(middleware(eventOf('POST', '/api/projects/rockets/launches', session('  ')))).resolves.toBeUndefined()
    })

    it("leaves a project that isn't here, and paths outside a project, to their routes", async () => {
        await expect(middleware(eventOf('POST', '/api/projects/ghost/launches', session('default')))).resolves.toBeUndefined()
        await expect(middleware(eventOf('POST', '/api/machines/claim', session('default')))).resolves.toBeUndefined()
        await expect(middleware(eventOf('GET', '/api/projects', session('default')))).resolves.toBeUndefined()
    })

    it('lets a preflight through', async () => {
        await expect(middleware(eventOf('OPTIONS', '/api/projects/rockets/launches', session('default')))).resolves.toBeUndefined()
    })
})

// A launcher's claim brings the project's workspace for the session to say. One whose workspace can't be read used to
// start in `default`, unnoticed; now it's refused before the launch is taken (ORR-1309).
describe("a claim on a project whose workspace can't be read", () => {
    it('is refused, and the launch is left unclaimed', async () => {
        const claim = vi.fn(() => true)
        vi.stubGlobal('getQuery', () => ({}))
        vi.stubGlobal('param', (_event: Event, name: string) => ({project: 'ghost', launch: 'abc'})[name])
        vi.stubGlobal('claim', claim)
        vi.stubGlobal('projectRepo', async () => null)
        vi.resetModules()
        const route = (await import('../server/api/projects/[project]/launches/[launch]/claim.post')).default as unknown as (event: Event) => Promise<unknown>
        await expect(route(eventOf('POST', '/api/projects/ghost/launches/abc/claim', {'orrery-launcher': 't'}))).rejects.toMatchObject({statusCode: 404})
        expect(claim).not.toHaveBeenCalled()
    })

    it("brings the project's workspace with a claim granted", async () => {
        vi.stubGlobal('getQuery', () => ({}))
        vi.stubGlobal('param', (_event: Event, name: string) => ({project: 'rockets', launch: 'abc'})[name])
        vi.stubGlobal('claim', () => true)
        vi.stubGlobal('projectRepo', async () => 'https://github.com/hati/rockets')
        vi.resetModules()
        const route = (await import('../server/api/projects/[project]/launches/[launch]/claim.post')).default as unknown as (event: Event) => Promise<unknown>
        expect(await route(eventOf('POST', '/api/projects/rockets/launches/abc/claim', {'orrery-launcher': 't'}))).toEqual({claimed: true, repo: 'https://github.com/hati/rockets', workspace: 'acme'})
    })
})
