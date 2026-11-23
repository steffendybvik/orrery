import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Show screen's route hands `viewLaunch` the person signed in (ORR-964, ORR-1223), as `middleware/auth.ts` sets them on
// the event with login on, so a session's screen is its own person's only. The refusal itself is `viewLaunch`'s, in
// launches.test.ts; this holds the route to passing the person on. Its h3 helpers are Nitro auto-imports.
type Event = {context?: {who?: {person: string}}}
let route: (event: Event) => Promise<unknown>
let authorized: string[]
let viewed: unknown[][]
let member: {person: string} | undefined

beforeEach(async () => {
    authorized = []
    viewed = []
    member = undefined
    vi.stubGlobal('memberAsking', async () => member)
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
        const [project, launch, now, viewer, asMember] = viewed[0]!
        expect([project, launch, typeof now, viewer, asMember]).toEqual(['greenhouse', 'abc', 'number', 'hati', false])
    })

    it('hands it nobody with login off, where there is only the one person', async () => {
        await route({context: {}})
        await route({})
        expect(viewed.map(args => args[3])).toEqual([undefined, undefined])
    })

    it('lets a member asking in person through, held to their own sessions (ORR-1349)', async () => {
        member = {person: 'hati'}
        await route({context: {who: {person: 'hati'}}})
        await route({})
        expect(authorized).toEqual([])
        expect(viewed.map(args => [args[3], args[4]])).toEqual([['hati', true], ['hati', true]])
    })
})
