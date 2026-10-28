import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal} from '#shared/roadmap'

// Which session takes a signal aimed at no session; `currentId`, `sessionNow` and `listSessions` are Nitro auto-imports.
let pool: typeof import('../server/utils/pool')
let states: Record<string, string>
/** The other projects each session hears (`also`), for one that spans several; its own project is greenhouse. */
let spans: Record<string, string[]>

beforeEach(async () => {
    states = {}
    spans = {}
    vi.stubGlobal('currentId', (id: string) => id === 'old' ? 'a' : id)
    vi.stubGlobal('untrustedSession', (id: string) => id === 'locked')
    vi.stubGlobal('sessionNow', (id: string) => states[id] ? {state: states[id], ...spans[id] ? {also: spans[id]} : {}} : undefined)
    vi.stubGlobal('listSessions', () => Object.keys(states).map(id => ({id, project: 'greenhouse', state: states[id], listening: true, ...spans[id] ? {also: spans[id]} : {}})))
    vi.resetModules()
    pool = await import('../server/utils/pool')
})

afterEach(() => vi.unstubAllGlobals())

const signal = (id: number, more: Partial<Signal> = {}): Signal =>
    ({id, project: 'greenhouse', kind: 'focus', issue: 'GRE-1', delivered_to: [], instructions: [], created_by: 'skoll', protected: true, created_at: '', ...more})

describe('a signal aimed at no session', () => {
    it('is pooled; one aimed at a session or every session, or a comment, is not', () => {
        expect(pool.pooled(signal(1))).toBe(true)
        expect([pool.pooled(signal(1, {target: 'a'})), pool.pooled(signal(1, {target: '*'})), pool.pooled(signal(1, {kind: 'comment'}))]).toEqual([false, false, false])
    })

    it('goes to the first idle session to take it, and to it again, by any id it has had', () => {
        states = {a: 'idle', b: 'idle'}
        expect(pool.take(signal(1), 'greenhouse', 'a')).toBe(true)
        expect(pool.take(signal(1), 'greenhouse', 'b')).toBe(false)
        expect(pool.take(signal(1), 'greenhouse', 'old')).toBe(true)
    })

    it("goes to the project's own idle session before one that spans several projects (ORR-283)", () => {
        states = {span: 'idle', own: 'idle'}
        spans = {span: ['pantry']}
        expect(pool.take(signal(1), 'greenhouse', 'span')).toBe(false)
        expect(pool.take(signal(1), 'greenhouse', 'own')).toBe(true)
        // With the project's own busy, the spanning one takes it.
        states.own = 'working'
        expect(pool.take(signal(2), 'greenhouse', 'span')).toBe(true)
    })

    it('waits while every session is busy, and goes to the first to go idle', () => {
        states = {a: 'working', b: 'waiting'}
        expect([pool.take(signal(1), 'greenhouse', 'a'), pool.take(signal(1), 'greenhouse', 'b')]).toEqual([false, false])
        states.b = 'idle'
        expect(pool.take(signal(1), 'greenhouse', 'b')).toBe(true)
    })

    it("isn't taken once delivered, and is free again when its taker's stream closes", () => {
        states = {a: 'idle', b: 'idle'}
        expect(pool.take(signal(1, {delivered_to: ['pantry']}), 'greenhouse', 'a')).toBe(false)
        pool.take(signal(2), 'greenhouse', 'a')
        pool.handBack('pantry', 'a')
        expect(pool.take(signal(2), 'greenhouse', 'b')).toBe(false)
        pool.handBack('greenhouse', 'a')
        expect(pool.take(signal(2), 'greenhouse', 'b')).toBe(true)
    })

    it('goes to a stream with no session (the Monitor tool) as it comes', () => {
        expect(pool.take(signal(1), 'greenhouse', undefined)).toBe(true)
        expect(pool.take(signal(1), 'greenhouse', undefined)).toBe(false)
    })
})

describe('a signal', () => {
    it('is for a session when aimed at it, at every session, or at none', () => {
        expect([pool.aimedAt(signal(1), 'a'), pool.aimedAt(signal(1, {target: '*'}), 'a'), pool.aimedAt(signal(1, {target: 'old'}), 'a'), pool.aimedAt(signal(1, {target: 'b'}), 'a')])
            .toEqual([true, true, true, false])
    })

    it("is for an untrusted schedule's session only when aimed at it", () => {
        expect([pool.aimedAt(signal(1), 'locked'), pool.aimedAt(signal(1, {target: '*'}), 'locked'), pool.aimedAt(signal(1, {target: 'locked'}), 'locked')])
            .toEqual([false, false, true])
    })
})
