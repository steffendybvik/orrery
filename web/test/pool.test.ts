import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal} from '#shared/roadmap'

// Which session takes a signal aimed at no session; `currentId` and `sessionNow` are Nitro auto-imports.
let pool: typeof import('../server/utils/pool')
let states: Record<string, string>

beforeEach(async () => {
    states = {}
    vi.stubGlobal('currentId', (id: string) => id === 'old' ? 'a' : id)
    vi.stubGlobal('sessionNow', (id: string) => states[id] ? {state: states[id]} : undefined)
    vi.resetModules()
    pool = await import('../server/utils/pool')
})

afterEach(() => vi.unstubAllGlobals())

const signal = (id: number, more: Partial<Signal> = {}): Signal =>
    ({id, project: 'larder', kind: 'focus', issue: 'LAR-1', delivered_to: [], instructions: [], created_by: 'skoll', protected: true, created_at: '', ...more})

describe('a signal aimed at no session', () => {
    it('is pooled; one aimed at a session or every session, or a comment, is not', () => {
        expect(pool.pooled(signal(1))).toBe(true)
        expect([pool.pooled(signal(1, {target: 'a'})), pool.pooled(signal(1, {target: '*'})), pool.pooled(signal(1, {kind: 'comment'}))]).toEqual([false, false, false])
    })

    it('goes to the first idle session to take it, and to it again, by any id it has had', () => {
        states = {a: 'idle', b: 'idle'}
        expect(pool.take(signal(1), 'larder', 'a')).toBe(true)
        expect(pool.take(signal(1), 'larder', 'b')).toBe(false)
        expect(pool.take(signal(1), 'larder', 'old')).toBe(true)
    })

    it('waits while every session is busy, and goes to the first to go idle', () => {
        states = {a: 'working', b: 'waiting'}
        expect([pool.take(signal(1), 'larder', 'a'), pool.take(signal(1), 'larder', 'b')]).toEqual([false, false])
        states.b = 'idle'
        expect(pool.take(signal(1), 'larder', 'b')).toBe(true)
    })

    it("isn't taken once delivered, and is free again when its taker's stream closes", () => {
        states = {a: 'idle', b: 'idle'}
        expect(pool.take(signal(1, {delivered_to: ['pantry']}), 'larder', 'a')).toBe(false)
        pool.take(signal(2), 'larder', 'a')
        pool.handBack('pantry', 'a')
        expect(pool.take(signal(2), 'larder', 'b')).toBe(false)
        pool.handBack('larder', 'a')
        expect(pool.take(signal(2), 'larder', 'b')).toBe(true)
    })

    it('goes to a stream with no session (the Monitor tool) as it comes', () => {
        expect(pool.take(signal(1), 'larder', undefined)).toBe(true)
        expect(pool.take(signal(1), 'larder', undefined)).toBe(false)
    })
})

describe('a signal', () => {
    it('is for a session when aimed at it, at every session, or at none', () => {
        expect([pool.aimedAt(signal(1), 'a'), pool.aimedAt(signal(1, {target: '*'}), 'a'), pool.aimedAt(signal(1, {target: 'old'}), 'a'), pool.aimedAt(signal(1, {target: 'b'}), 'a')])
            .toEqual([true, true, true, false])
    })
})
