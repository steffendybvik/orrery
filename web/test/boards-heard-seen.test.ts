import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// A session marked untrusted still hears only the projects its credential sees (ORR-1372): the mark, which the owner's
// own credential can send, used to skip that and hear every workspace's.
let sees: Set<string> | undefined
type Event = {headers: Record<string, string>}

beforeEach(() => {
    vi.doMock('../server/utils/member-sees', () => ({memberSees: async () => sees}))
    vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
    vi.stubGlobal('chatWrite', () => false)
    vi.resetModules()
})

afterEach(() => {
    vi.doUnmock('../server/utils/member-sees')
    vi.unstubAllGlobals()
})

describe('boardsHeard', () => {
    it("keeps an untrusted session to the projects its credential sees", async () => {
        const {boardsHeard} = await import('../server/utils/board')
        sees = new Set(['mine'])
        expect(await boardsHeard({headers: {'orrery-untrusted': 'yes'}} as never, ['mine', 'bobs'])).toEqual(['mine'])
    })

    it('leaves it every project with login off', async () => {
        const {boardsHeard} = await import('../server/utils/board')
        sees = undefined
        expect(await boardsHeard({headers: {'orrery-untrusted': 'yes'}} as never, ['mine', 'bobs'])).toEqual(['mine', 'bobs'])
    })
})
