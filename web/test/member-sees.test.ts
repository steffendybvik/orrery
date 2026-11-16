import type {H3Event} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {listedSees, memberSees, needsSeen} from '../server/utils/member-sees'

// What a signed-in member who isn't the owner can read on the routes this server answers itself (ORR-1195): the
// projects the API lists for them, asked as them; the owner and anyone with login off, every one.
const asked = vi.fn(async () => [{id: 'rockets'}])
const eventOf = (who?: {person: string, owner: boolean, via: 'browser'}, workspace?: string) =>
    ({context: {who}, workspace}) as unknown as H3Event

beforeEach(() => {
    asked.mockClear()
    vi.stubGlobal('readAsAsker', asked)
    vi.stubGlobal('getHeader', (event: {workspace?: string}, name: string) => name === 'orrery-workspace' ? event.workspace : undefined)
    vi.stubGlobal('createError', (e: {statusCode: number, message: string}) => Object.assign(new Error(e.message), e))
})
afterEach(() => vi.unstubAllGlobals())

describe('memberSees', () => {
    it('holds nobody back for the owner or with login off, and asks nothing', async () => {
        expect(await memberSees(eventOf())).toBeUndefined()
        expect(await memberSees(eventOf({person: 'sam', owner: true, via: 'browser'}))).toBeUndefined()
        expect(asked).not.toHaveBeenCalled()
    })

    it('gives a member the projects the API lists for them, and a 404 for any other', async () => {
        const bo = eventOf({person: 'bo-sees', owner: false, via: 'browser'})
        expect([...await memberSees(bo) ?? []]).toEqual(['rockets'])
        await expect(needsSeen(bo, 'rockets')).resolves.toBeUndefined()
        await expect(needsSeen(bo, 'primes')).rejects.toMatchObject({statusCode: 404})
        expect(asked).toHaveBeenCalledTimes(1)
    })
})

// A list across projects, as the Sessions page reads it, holds the one workspace the page is in, the owner's too
// (ORR-1251): the API lists its projects alone, so asking is kept per person and workspace.
describe('listedSees', () => {
    it('holds nobody back with login off', async () => {
        expect(await listedSees(eventOf())).toBeUndefined()
        expect(asked).not.toHaveBeenCalled()
    })

    it("asks the API for the owner too, and keeps each workspace's answer apart", async () => {
        const home = eventOf({person: 'sam-listed', owner: true, via: 'browser'})
        expect([...await listedSees(home) ?? []]).toEqual(['rockets'])
        asked.mockResolvedValueOnce([{id: 'primes'}])
        expect([...await listedSees(eventOf({person: 'sam-listed', owner: true, via: 'browser'}, 'acme')) ?? []]).toEqual(['primes'])
        expect([...await listedSees(home) ?? []]).toEqual(['rockets'])
        expect(asked).toHaveBeenCalledTimes(2)
    })

    it('holds nobody back when the API gives no answer', async () => {
        asked.mockResolvedValueOnce(undefined as never)
        expect(await listedSees(eventOf({person: 'nobody-answers', owner: true, via: 'browser'}))).toBeUndefined()
    })
})
