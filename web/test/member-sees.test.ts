import type {H3Event} from 'h3'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {memberSees, needsSeen} from '../server/utils/member-sees'

// What a signed-in member who isn't the owner can read on the routes this server answers itself (ORR-1195): the
// projects the API lists for them, asked as them; the owner and anyone with login off, every one.
const asked = vi.fn(async () => [{id: 'rockets'}])
const eventOf = (who?: {person: string, owner: boolean, via: 'browser'}) => ({context: {who}}) as unknown as H3Event

beforeEach(() => {
    asked.mockClear()
    vi.stubGlobal('readAsAsker', asked)
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
