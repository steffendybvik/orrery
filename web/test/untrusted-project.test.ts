import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// An untrusted schedule's session is held to the project it was started for on the server, not only by its channel's
// `projectOf` (ORR-1069): what it read can't steer it into raising proposals on another board.
type Event = {method: string, path: string, headers: Record<string, string>}
let handler: (event: Event) => Promise<void>

const asking = (path: string, method = 'POST', headers: Record<string, string> = {'orrery-untrusted': 'yes', 'orrery-session': 'untrusted-1'}): Event =>
    ({method, path, headers})
const status = (done: Promise<unknown>) => done.then(() => 200, (error: {statusCode: number}) => error.statusCode)

beforeEach(async () => {
    vi.stubGlobal('defineEventHandler', (h: unknown) => h)
    vi.stubGlobal('createError', (e: {statusCode: number, message: string}) => Object.assign(new Error(e.message), e))
    vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
    vi.stubGlobal('sessionHeader', (event: Event) => event.headers['orrery-session'])
    // orrery knows untrusted-1, started for greenhouse; untrusted-2 it doesn't know yet (it restarted).
    vi.stubGlobal('untrustedProject', (id: string | undefined) => id === 'untrusted-1' ? 'greenhouse' : undefined)
    vi.stubGlobal('useStore', () => ({projectId: async (id: string) => id === 'GRE' ? 'greenhouse' : id}))
    vi.doMock('../server/utils/guard', () => ({guard: async () => {}}))
    vi.resetModules()
    handler = (await import('../server/middleware/untrusted')).default as unknown as typeof handler
})

afterEach(() => {
    vi.doUnmock('../server/utils/guard')
    vi.unstubAllGlobals()
})

describe("an untrusted session's project", () => {
    it('lets it write to the project it was started for, by its id or anything that names it', async () => {
        expect(await status(handler(asking('/api/projects/greenhouse/issues')))).toBe(200)
        expect(await status(handler(asking('/api/projects/GRE/issues/GRE-4/comments')))).toBe(200)
    })

    it('refuses its writes to any other project', async () => {
        expect(await status(handler(asking('/api/projects/pantry/issues')))).toBe(403)
        expect(await status(handler(asking('/api/projects/pantry/issues/PAN-1/comments')))).toBe(403)
    })

    it('leaves reads alone, and a session orrery doesn\'t know yet to the permissions table alone', async () => {
        expect(await status(handler(asking('/api/projects/pantry/issues', 'GET')))).toBe(200)
        expect(await status(handler(asking('/api/projects/pantry/issues', 'POST', {'orrery-untrusted': 'yes', 'orrery-session': 'untrusted-2'})))).toBe(200)
    })

    it('holds nothing to a session that isn\'t untrusted', async () => {
        expect(await status(handler(asking('/api/projects/pantry/issues', 'POST', {'orrery-session': 'untrusted-1'})))).toBe(200)
    })
})
