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

    it("holds the owner's bell notices and log rows to the projects they see (ORR-1353)", () => {
        const hearing = streamHearing({person: 'sam', owner: true, via: 'browser'}, seen)
        expect(hearing.hearsNotice({project: 'rockets'})).toBe(true)
        expect(hearing.hearsNotice({project: 'theirs'})).toBe(false)
        expect(hearing.hearsLogged({event: {project: 'rockets'}})).toBe(true)
        expect(hearing.hearsLogged({event: {project: 'theirs'}})).toBe(false)
        expect(hearing.hearsLogged({event: {kind: 'server.error'}})).toBe(true)
    })

    // A line is in one workspace's log, and only that workspace's tabs hear it (ORR-1386).
    it("hears a log row only in its own workspace's tab", () => {
        const sam = {person: 'sam', owner: true, via: 'browser'} as const
        const home = streamHearing(sam, seen)
        expect(home.hearsLogged({event: {kind: 'server.error', workspace: 'default'}})).toBe(true)
        expect(home.hearsLogged({event: {kind: 'request.refused', workspace: 'acme'}})).toBe(false)
        const acme = streamHearing(sam, seen, 'acme')
        expect(acme.hearsLogged({event: {kind: 'request.refused', workspace: 'acme'}})).toBe(true)
        expect(acme.hearsLogged({event: {kind: 'server.error'}})).toBe(false)
        // With login off too: a tab is one workspace's.
        expect(streamHearing(undefined, seen).hearsLogged({event: {workspace: 'acme'}})).toBe(false)
    })

    it('gives a member no bell notice or log row, even of a project they see', () => {
        const hearing = streamHearing({person: 'bo', owner: false, via: 'browser'}, seen)
        expect(hearing.hearsNotice({project: 'rockets'})).toBe(false)
        expect(hearing.hearsLogged({event: {project: 'rockets'}})).toBe(false)
        expect(hearing.hearsLogged({event: {}})).toBe(false)
    })
})
