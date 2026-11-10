import {beforeEach, describe, expect, it, vi} from 'vitest'
import {PullPoll} from '../server/utils/pull-poll'
import {Pulls} from '../server/utils/pulls'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// The poll's writes go through the Rust API when it's in front (ORR-1095): it's the one writer of `pull_states`,
// `pull_repos` and `issue_pulls` then, so nothing is written to the database here.
const sent: {method: string, path: string, body: unknown, actor: unknown, always: unknown}[] = []
let inFront = true
vi.mock('../server/utils/api-router', () => ({
    writeToApi: async (method: string, path: string, body: unknown, actor: unknown, opts: {always?: boolean} = {}) => {
        if (!inFront) return undefined
        sent.push({method, path, body, actor, always: opts.always})
        return {reply: path === '/api/pulls/forget' ? {gone: ['you/old']} : null}
    },
}))

let store: Store
let poll: PullPoll
let pulls: Pulls

beforeEach(async () => {
    sent.length = 0
    inFront = true
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO', repo: 'https://github.com/you/shop'})
    await store.createIssue('shop', {title: 'Pay with cards'})
    pulls = new Pulls(store, async () => { throw new Error('no GitHub here') })
    poll = new PullPoll(store, pulls, async () => false, () => {}, () => {})
})

const row = {number: 1, names: ['SHO-1'], title: 'PR 1', url: 'u', branch: 'feat/sho-1', base: 'main', author: 'claude', draft: false, head_sha: 'a',
    state: 'clean', review: null, review_id: null, checks: 'success', merged: false, closed: false, merge_sha: null, closed_by: null,
    created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:00:00Z', told: []}
const count = async (table: string) => (await store.db.get<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`))!.n

describe("the poll's writes through the Rust API (ORR-1095)", () => {
    it('sends each step there as orrery, and writes nothing here', async () => {
        const polled = {at: '2026-11-10T10:01:00Z', token: true, more: false, pulls: [row]}
        await poll.keepPolled('you/shop', polled)
        await poll.keepFailed('you/shop', 'GitHub said no')
        await poll.keepHistory('you/shop', 2)
        expect(await poll.keepForgotten(['you/shop'], '2026-11-03T10:00:00Z')).toEqual(['you/old'])
        await pulls.remember('you/shop', ['shop'], {...row, merged_at: null, names: ['SHO-1']})
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual([
            'PUT /api/pulls/you/shop', 'PUT /api/pulls/you/shop/error', 'PUT /api/pulls/you/shop/history', 'POST /api/pulls/forget', 'PUT /api/pulls/you/shop/1',
        ])
        expect(sent.every(s => s.always === true && (s.actor as {name: string}).name === 'orrery')).toBe(true)
        expect(sent[0]!.body).toEqual(polled)
        expect(sent[3]!.body).toEqual({repos: ['you/shop'], before: '2026-11-03T10:00:00Z'})
        // Only the fields the API's PUT takes, the projects with them.
        expect(sent[4]!.body).toEqual({projects: ['shop'], names: ['SHO-1'], title: 'PR 1', url: 'u', branch: 'feat/sho-1', base: 'main', author: 'claude',
            merged: false, closed: false, merged_at: null, created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:00:00Z'})
        expect([await count('pull_states'), await count('pull_repos'), await count('issue_pulls')]).toEqual([0, 0, 0])
    })

    it('writes to the database here without the API', async () => {
        inFront = false
        await poll.keepPolled('you/shop', {at: '2026-11-10T10:01:00Z', token: true, more: false, pulls: [row]})
        await pulls.remember('you/shop', ['shop'], {...row, merged_at: null, names: ['SHO-1']})
        expect(sent).toEqual([])
        expect([await count('pull_states'), await count('pull_repos'), await count('issue_pulls')]).toEqual([1, 1, 1])
    })
})
