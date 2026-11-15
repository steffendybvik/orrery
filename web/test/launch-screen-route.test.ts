import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Show screen's route hands `viewLaunch` the person signed in (ORR-964, ORR-1223), as `middleware/auth.ts` sets them on
// the event with login on, so a session's screen is its own person's only. The refusal itself is `viewLaunch`'s, in
// launches.test.ts; this holds the route to passing the person on. Its h3 helpers are Nitro auto-imports.
type Event = {context?: {who?: {person: string}}}
let route: (event: Event) => Promise<unknown>
let authorized: string[]
let viewed: unknown[][]

beforeEach(async () => {
    authorized = []
    viewed = []
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('authorize', async (_event: Event, permission: string) => void authorized.push(permission))
    vi.stubGlobal('param', (_event: Event, name: string) => ({project: 'greenhouse', launch: 'abc'})[name])
    vi.stubGlobal('viewLaunch', (...args: unknown[]) => {
        viewed.push(args)
        return {screen: null}
    })
    vi.resetModules()
    route = (await import('../server/api/projects/[project]/launches/[launch]/screen.get')).default as unknown as typeof route
})

afterEach(() => vi.unstubAllGlobals())

describe("Show screen's route", () => {
    it('asks for sessions.watch, and hands viewLaunch the person signed in', async () => {
        expect(await route({context: {who: {person: 'hati'}}})).toEqual({screen: null})
        expect(authorized).toEqual(['sessions.watch'])
        expect(viewed).toHaveLength(1)
        const [project, launch, now, viewer] = viewed[0]!
        expect([project, launch, typeof now, viewer]).toEqual(['greenhouse', 'abc', 'number', 'hati'])
    })

    it('hands it nobody with login off, where there is only the one person', async () => {
        await route({context: {}})
        await route({})
        expect(viewed.map(args => args[3])).toEqual([undefined, undefined])
    })
})
