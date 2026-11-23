import {describe, expect, it} from 'vitest'
import {streamHearing} from '../server/utils/stream-hearing'

// What a subscriber to /api/events hears (ORR-1195, ORR-1347): anyone signed in, the owner too, only the boards of the
// tab's workspace they can see; a member none of the owner's own.
describe('streamHearing', () => {
    const seen = () => new Set(['rockets'])

    it('gives anyone with login off everything', () => {
        const hearing = streamHearing(undefined, seen)
        expect([hearing.held, hearing.sees('primes'), hearing.sees(null), hearing.ownersToo]).toEqual([false, true, true, true])
    })

    it("holds the server's owner to their own boards, with what's the owner's own", () => {
        const hearing = streamHearing({person: 'sam', owner: true, via: 'browser'}, seen)
        expect([hearing.held, hearing.sees('rockets'), hearing.sees('theirs'), hearing.ownersToo]).toEqual([true, true, false, true])
    })

    it('gives a member their own boards alone, and nothing of the owner\'s', () => {
        const hearing = streamHearing({person: 'bo', owner: false, via: 'browser'}, seen)
        expect(hearing.sees('rockets')).toBe(true)
        expect(hearing.sees('primes')).toBe(false)
        expect(hearing.sees(undefined)).toBe(false)
        expect(hearing.ownersToo).toBe(false)
    })

    it('hears every board while there is no API to ask (seen undefined)', () => {
        const hearing = streamHearing({person: 'sam', owner: true, via: 'browser'}, () => undefined)
        expect(hearing.sees('anything')).toBe(true)
    })
})
