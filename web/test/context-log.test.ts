import {beforeEach, describe, expect, it, vi} from 'vitest'
import {CONTEXT_KEPT, CONTEXT_TEXT_KEPT} from '../shared/context'

// What each running session has been given as it works (ORR-549), with Nitro's auto-imports stubbed: `s0` went by
// `old` before a `/clear`.
let log: typeof import('../server/utils/context-log')

beforeEach(async () => {
    vi.stubGlobal('currentId', (id: string) => id === 'old' ? 's0' : id)
    vi.stubGlobal('sessionIds', (id: string) => id === 's0' ? ['s0', 'old'] : [id])
    vi.resetModules()
    log = await import('../server/utils/context-log')
})

describe("a session's context so far", () => {
    it('keeps each signal and tool answer with its size, newest first', () => {
        log.noteContext('s1', 'signal', 'focus · ORR-1', '{"note":"go"}')
        log.noteContext('s1', 'tool', 'issue', 'ORR-1 [todo] Shelves')
        expect(log.contextSoFar('s1').map(e => [e.kind, e.title, e.chars, e.tokens])).toEqual([['tool', 'issue', 20, 5], ['signal', 'focus · ORR-1', 13, 4]])
        expect(log.contextSoFar('s2')).toEqual([])
    })

    it('keeps only the latest, and cuts a long text while counting all of it', () => {
        for (let i = 0; i < CONTEXT_KEPT + 5; i++) log.noteContext('s1', 'tool', `t${i}`, 'x')
        expect(log.contextSoFar('s1')).toHaveLength(CONTEXT_KEPT)
        expect(log.contextSoFar('s1')[0]!.title).toBe(`t${CONTEXT_KEPT + 4}`)
        log.noteContext('s1', 'tool', 'guide', 'y'.repeat(CONTEXT_TEXT_KEPT + 10))
        expect(log.contextSoFar('s1')[0]).toMatchObject({chars: CONTEXT_TEXT_KEPT + 10})
        expect(log.contextSoFar('s1')[0]!.text).toHaveLength(CONTEXT_TEXT_KEPT)
    })

    it('follows a session through a /clear, under the id it goes by now', () => {
        log.noteContext('old', 'tool', 'docs', 'a')
        log.noteContext('s0', 'tool', 'doc', 'b')
        expect(log.contextSoFar('s0').map(e => e.title).sort()).toEqual(['doc', 'docs'])
    })
})
