import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {AllPulls, OpenPull} from '#shared/roadmap'

// Poll now keeps to the asker's repos (ORR-1371): another workspace's are neither polled with their token, nor listed,
// nor told apart from a repo no project is on.
const pr = (repo: string, number: number) => ({number, repo, title: `PR ${number}`, url: 'u', branch: 'b', base: 'main', author: 'a', state: 'ready',
    created_at: '2026-11-23T10:00:00Z', updated_at: '2026-11-23T10:00:00Z'}) as OpenPull
const all: AllPulls = {pulls: [pr('me/shop', 1), pr('bob/secret', 2)], open: 2, needs: 0,
    repos: [{repo: 'me/shop', open: 1, needs: 0}, {repo: 'bob/secret', open: 1, needs: 0}] as AllPulls['repos']}
let polled: (string | undefined)[]
let seen: Set<string> | undefined
let route: (event: {query?: Record<string, string>}) => Promise<AllPulls>
const httpError = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})

beforeEach(async () => {
    polled = []
    seen = new Set(['me/shop'])
    vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
    vi.stubGlobal('getQuery', (event: {query?: Record<string, string>}) => event.query ?? {})
    vi.stubGlobal('authorize', async () => ({name: 'skoll', owner: true}))
    vi.stubGlobal('notFound', httpError(404))
    vi.stubGlobal('reposSeen', async () => seen)
    vi.stubGlobal('usePulls', () => ({repos: async () => new Map([['me/shop', ['shop']], ['bob/secret', ['bobs']]]), all: async () => all}))
    vi.stubGlobal('usePullPoll', () => ({pollNow: async (only?: string) => {
        polled.push(only)
        return new Map<string, string>()
    }}))
    vi.stubGlobal('pullsPage', (await import('../server/utils/pulls')).pullsPage)
    vi.resetModules()
    route = (await import('../server/api/pulls/poll.post')).default as unknown as typeof route
})

afterEach(() => vi.unstubAllGlobals())

describe('Poll now', () => {
    it("polls and lists the asker's repos alone", async () => {
        const answer = await route({})
        expect(polled).toEqual(['me/shop'])
        expect(answer.pulls.map(p => p.repo)).toEqual(['me/shop'])
        expect(JSON.stringify(answer)).not.toContain('bob/secret')
    })

    it("answers another person's repo as one no project is on", async () => {
        await expect(route({query: {repo: 'bob/secret'}})).rejects.toMatchObject({statusCode: 404})
        await expect(route({query: {repo: 'nobody/here'}})).rejects.toMatchObject({statusCode: 404})
        expect(polled).toEqual([])
    })

    it('polls every repo at once with login off', async () => {
        seen = undefined
        const answer = await route({})
        expect(polled).toEqual([undefined])
        expect(answer.pulls).toHaveLength(2)
    })
})
