import {describe, expect, it} from 'vitest'
import {streamHearing} from '../server/utils/stream-hearing'

// What a subscriber to /api/events hears (ORR-1195): a member only the boards they can see, and none of the owner's own.
describe('streamHearing', () => {
    const seen = () => new Set(['rockets'])

    it('gives the owner, and anyone with login off, everything', () => {
        for (const who of [undefined, {person: 'steffen', owner: true, via: 'browser' as const}]) {
            const hearing = streamHearing(who, seen)
            expect([hearing.sees('primes'), hearing.sees(null), hearing.ownersToo]).toEqual([true, true, true])
        }
    })

    it('gives a member their own boards alone, and nothing of the owner\'s', () => {
        const hearing = streamHearing({person: 'bo', owner: false, via: 'browser'}, seen)
        expect(hearing.sees('rockets')).toBe(true)
        expect(hearing.sees('primes')).toBe(false)
        expect(hearing.sees(undefined)).toBe(false)
        expect(hearing.ownersToo).toBe(false)
    })
})
