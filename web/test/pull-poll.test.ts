import {beforeEach, describe, expect, it} from 'vitest'
import type {EventEntry} from '../server/utils/event-log'
import type {PullChange} from '../server/utils/pull-poll'
import {changesOf, PullPoll, POLL_WITHOUT_TOKEN} from '../server/utils/pull-poll'
import {Pulls} from '../server/utils/pulls'
import {Secrets} from '../server/utils/secrets'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// The background poll of the projects' PRs (ORR-506), with GitHub stubbed: one GraphQL query a minute with a token,
// two REST lists every ten minutes without, what each PR was kept, and each change told once.
const me = {name: 'skoll', owner: true}
const TOKEN = 'ghp_abcdef1234567890'
let store: Store
let secrets: Secrets
let now: number
let asked: {url: string, method: string, auth: string | null}[]
let open: Record<string, unknown>[]
let done: Record<string, unknown>[]
let rest: Record<string, () => Response>
let refuse: boolean
let changes: PullChange[]
let notes: EventEntry[]
let pulls: Pulls
let poll: PullPoll

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})

/** A PR as GitHub's GraphQL gives it. */
function pr(number: number, over: Record<string, unknown> = {}) {
    return {
        number, title: `PR ${number}`, url: `https://github.com/you/shop/pull/${number}`, body: '', isDraft: false,
        headRefName: `feat/sho-${number}-work`, baseRefName: 'main', headRefOid: `sha${number}a`, createdAt: '2026-10-29T08:00:00Z',
        updatedAt: '2026-10-29T09:00:00Z', author: {login: 'claude'}, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
        reviewDecision: null, merged: false, closed: false, mergeCommit: null, reviews: {nodes: []},
        commits: {nodes: [{commit: {statusCheckRollup: {state: 'SUCCESS'}}}]}, ...over,
    }
}

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO', repo: 'https://github.com/you/shop'})
    await store.createIssue('shop', {title: 'Pay with cards'})
    await store.createIssue('shop', {title: 'Refunds'})
    now = Date.parse('2026-10-29T10:00:00Z')
    asked = []
    open = []
    done = []
    rest = {}
    refuse = false
    changes = []
    notes = []
    const send = async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        asked.push({url: String(url), method: init?.method ?? 'GET', auth: headers.get('authorization')})
        const path = new URL(String(url)).pathname + new URL(String(url)).search
        if (refuse) return json({message: 'Bad credentials'}, 401)
        if (path === '/graphql') return json({data: {repository: {open: {nodes: open}, done: {nodes: done}}}})
        return rest[path]?.() ?? json({message: 'Not Found'}, 404)
    }
    secrets = new Secrets(store, () => 'a long random test key', () => {}, send as typeof fetch)
    pulls = new Pulls(store, (url, project, headers, init) => secrets.own(url, 'GITHUB_TOKEN', project, headers, init), () => now)
    poll = new PullPoll(store, pulls, project => secrets.ownsFor('https://api.github.com/graphql', 'GITHUB_TOKEN', project),
        change => changes.push(change), entry => notes.push(entry), () => now)
})

const withToken = () => secrets.set('GITHUB_TOKEN', {value: TOKEN, hosts: ['api.github.com']}, me)
/** The next poll, a minute on. */
async function minuteOn() {
    now += 60_000
    await poll.tick()
}

describe('the pull request poll', () => {
    it('records on its first poll of a repo, then tells each change once, on the issue the PR names', async () => {
        await withToken()
        open = [pr(1, {mergeStateStatus: 'DIRTY'}), pr(2)]
        await poll.tick()
        // Turning it on tells nothing of the PRs already open.
        expect(changes).toEqual([])
        expect(asked).toMatchObject([{url: 'https://api.github.com/graphql', method: 'POST', auth: `Bearer ${TOKEN}`}])

        open = [pr(1, {mergeStateStatus: 'DIRTY'}), pr(2, {mergeStateStatus: 'DIRTY'})]
        await minuteOn()
        expect(changes).toEqual([{project: 'shop', issue: 'SHO-2', repo: 'you/shop', kind: 'conflicting', key: 'you/shop#2 conflicting sha2a',
            pull: {number: 2, title: 'PR 2', url: 'https://github.com/you/shop/pull/2', branch: 'feat/sho-2-work', base: 'main', head_sha: 'sha2a', merge_sha: null, closed_by: null, review_id: null}}])

        // GitHub working it out again, then conflicting again on the same commit: nothing new.
        open = [pr(1, {mergeStateStatus: 'DIRTY'}), pr(2, {mergeStateStatus: 'UNKNOWN'})]
        await minuteOn()
        open = [pr(1, {mergeStateStatus: 'DIRTY'}), pr(2, {mergeStateStatus: 'DIRTY'})]
        await minuteOn()
        expect(changes).toHaveLength(1)
        // A new commit that still conflicts is a new change.
        open = [pr(1, {mergeStateStatus: 'DIRTY'}), pr(2, {mergeStateStatus: 'CLEAN', headRefOid: 'sha2b'})]
        await minuteOn()
        open = [pr(1, {mergeStateStatus: 'DIRTY'}), pr(2, {mergeStateStatus: 'DIRTY', headRefOid: 'sha2b'})]
        await minuteOn()
        expect(changes.map(c => [c.kind, c.key])).toEqual([
            ['conflicting', 'you/shop#2 conflicting sha2a'],
            ['ready', 'you/shop#2 ready sha2b'],
            ['conflicting', 'you/shop#2 conflicting sha2b'],
        ])
    })

    it('asks a repo once a minute with a token', async () => {
        await withToken()
        await poll.tick()
        now += 30_000
        await poll.tick()
        expect(asked).toHaveLength(1)
        now += 30_000
        await poll.tick()
        expect(asked).toHaveLength(2)
    })

    it('tells failing checks, changes requested by each review, and approval', async () => {
        await withToken()
        open = [pr(1)]
        await poll.tick()
        open = [pr(1, {commits: {nodes: [{commit: {statusCheckRollup: {state: 'FAILURE'}}}]}, mergeStateStatus: 'UNSTABLE'})]
        await minuteOn()
        open = [pr(1, {reviewDecision: 'CHANGES_REQUESTED', reviews: {nodes: [{id: 'R1'}]}})]
        await minuteOn()
        open = [pr(1, {reviewDecision: 'APPROVED', reviews: {nodes: [{id: 'R1'}]}})]
        await minuteOn()
        open = [pr(1, {reviewDecision: 'CHANGES_REQUESTED', reviews: {nodes: [{id: 'R2'}]}})]
        await minuteOn()
        expect(changes.map(c => c.key)).toEqual([
            'you/shop#1 checks_failed sha1a',
            // Green again: back to ready.
            'you/shop#1 ready sha1a',
            'you/shop#1 changes_requested R1',
            'you/shop#1 approved sha1a',
            'you/shop#1 changes_requested R2',
        ])
    })

    it('counts each failure of a PR\'s checks, and hands on who asked for changes, what they wrote and where', async () => {
        await withToken()
        const failing = (sha: string) => pr(1, {headRefOid: sha, commits: {nodes: [{commit: {statusCheckRollup: {state: 'FAILURE'}}}]}})
        open = [pr(1)]
        await poll.tick()
        for (const sha of ['f1', 'ok1', 'f2']) {
            open = [sha.startsWith('ok') ? pr(1, {headRefOid: sha}) : failing(sha)]
            await minuteOn()
        }
        expect(changes.filter(c => c.kind === 'checks_failed').map(c => c.failures)).toEqual([1, 2])
        open = [pr(1, {headRefOid: 'f2', reviewDecision: 'CHANGES_REQUESTED', reviews: {nodes: [{id: 'R1', author: {login: 'skoll'}, body: 'Split it.', comments: {nodes: [{path: 'a.ts', line: 3, body: 'Rename.'}]}}]}})]
        await minuteOn()
        expect(changes.at(-1)).toMatchObject({kind: 'changes_requested', review: {by: 'skoll', body: 'Split it.', comments: [{path: 'a.ts', line: 3, body: 'Rename.'}]}})
    })

    it('tells a merge, with its commit, and a close without one, with who closed it; not a PR it never kept', async () => {
        await withToken()
        open = [pr(1), pr(2)]
        await poll.tick()
        open = []
        done = [
            pr(1, {merged: true, closed: true, mergeCommit: {oid: 'm1'}}),
            pr(2, {closed: true, timelineItems: {nodes: [{actor: {login: 'steffen'}}]}}),
            pr(3, {merged: true, closed: true, mergeCommit: {oid: 'm3'}}),
        ]
        await minuteOn()
        expect(changes.map(c => [c.kind, c.issue, c.pull.merge_sha, c.pull.closed_by])).toEqual([['merged', 'SHO-1', 'm1', null], ['closed', 'SHO-2', null, 'steffen']])
        await minuteOn()
        expect(changes).toHaveLength(2)
    })

    it('tells nothing for a PR that names no issue, and keeps it for the pages', async () => {
        await withToken()
        open = [pr(5, {headRefName: 'chore/deps'})]
        await poll.tick()
        open = [pr(5, {headRefName: 'chore/deps', mergeStateStatus: 'DIRTY'})]
        await minuteOn()
        expect(changes).toEqual([])
        expect((await pulls.all()).pulls.map(p => [p.number, p.state, p.issue])).toEqual([[5, 'conflicting', undefined]])
    })

    it('feeds the pages while fresh, asking GitHub nothing more', async () => {
        await withToken()
        open = [pr(1, {mergeStateStatus: 'DIRTY', body: 'Issue: http://localhost:9010/p/shop/issues/SHO-2'}), pr(2, {isDraft: true, mergeStateStatus: 'DRAFT'})]
        await poll.tick()
        asked = []
        const two = await pulls.forIssue('shop', 'SHO-2')
        expect(two).toMatchObject({repo: 'you/shop', token: true, checked_at: '2026-10-29T10:00:00.000Z'})
        expect(two.pulls.map(p => [p.number, p.state])).toEqual([[1, 'conflicting'], [2, 'draft']])
        expect((await pulls.all()).pulls.map(p => [p.number, p.issue?.id])).toEqual([[1, 'SHO-2'], [2, 'SHO-2']])
        expect(asked).toEqual([])
        // Gone stale (the poll stopped), the pages ask GitHub again.
        now += 4 * 60_000
        rest['/repos/you/shop/pulls?state=open&per_page=100'] = () => json([])
        await pulls.forIssue('shop', 'SHO-1')
        expect(asked.map(a => a.url)).toEqual(['https://api.github.com/repos/you/shop/pulls?state=open&per_page=100'])
    })

    it('reads the lists every ten minutes without a token, telling merges and closes but no state', async () => {
        const listed = (number: number, over: Record<string, unknown> = {}) => ({
            number, title: `PR ${number}`, html_url: `https://github.com/you/shop/pull/${number}`, draft: false, body: '', user: {login: 'claude'},
            head: {ref: `feat/sho-${number}-work`, sha: `sha${number}`}, base: {ref: 'main'}, created_at: '2026-10-29T08:00:00Z', updated_at: '2026-10-29T09:00:00Z', ...over,
        })
        rest['/repos/you/shop/pulls?state=open&per_page=100'] = () => json([listed(1)])
        rest['/repos/you/shop/pulls?state=closed&sort=updated&direction=desc&per_page=30'] = () => json([])
        await poll.tick()
        expect(asked.map(a => [a.method, a.auth])).toEqual([['GET', null], ['GET', null]])
        await minuteOn()
        expect(asked).toHaveLength(2)
        rest['/repos/you/shop/pulls?state=open&per_page=100'] = () => json([])
        rest['/repos/you/shop/pulls?state=closed&sort=updated&direction=desc&per_page=30'] = () => json([listed(1, {merged_at: '2026-10-29T10:05:00Z', merge_commit_sha: 'm1', closed_at: '2026-10-29T10:05:00Z'})])
        now += POLL_WITHOUT_TOKEN
        await poll.tick()
        expect(changes.map(c => [c.kind, c.pull.merge_sha])).toEqual([['merged', 'm1']])
        // The pages don't read what it keeps without a token: it doesn't know the states.
        rest['/repos/you/shop/pulls?state=open&per_page=100'] = () => json([])
        asked = []
        await pulls.forIssue('shop', 'SHO-1')
        expect(asked).toHaveLength(1)
    })

    it('says once that GitHub turned the token down, and asks that repo again an hour on', async () => {
        await withToken()
        refuse = true
        await poll.tick()
        expect(notes).toMatchObject([{level: 'warn', kind: 'github.refused'}])
        await minuteOn()
        expect(asked).toHaveLength(1)
        now += 60 * 60_000
        await poll.tick()
        expect(asked).toHaveLength(2)
        expect(notes).toHaveLength(1)
        // Working again, a later refusal is said again.
        refuse = false
        now += 60 * 60_000
        await poll.tick()
        refuse = true
        await minuteOn()
        expect(notes).toHaveLength(2)
    })

    it('still only records on the first poll that works, after one that failed (ORR-525)', async () => {
        await withToken()
        refuse = true
        await poll.tick()
        expect(await store.db.all('SELECT * FROM pull_repos')).toEqual([])
        refuse = false
        open = [pr(1, {mergeStateStatus: 'DIRTY'}), pr(2, {commits: {nodes: [{commit: {statusCheckRollup: {state: 'FAILURE'}}}]}})]
        now += 60 * 60_000
        await poll.tick()
        expect(changes).toEqual([])
        // And tells what changes after it.
        open = [pr(1, {mergeStateStatus: 'BEHIND'}), pr(2, {commits: {nodes: [{commit: {statusCheckRollup: {state: 'FAILURE'}}}]}})]
        await minuteOn()
        expect(changes.map(c => c.key)).toEqual(['you/shop#1 behind sha1a'])
    })

    it('only records on its first poll with a token, after polls without one (ORR-525)', async () => {
        const listed = (number: number) => ({
            number, title: `PR ${number}`, html_url: `https://github.com/you/shop/pull/${number}`, draft: false, body: '', user: {login: 'claude'},
            head: {ref: `feat/sho-${number}-work`, sha: `sha${number}a`}, base: {ref: 'main'}, created_at: '2026-10-29T08:00:00Z', updated_at: '2026-10-29T09:00:00Z',
        })
        rest['/repos/you/shop/pulls?state=open&per_page=100'] = () => json([listed(1), listed(2)])
        rest['/repos/you/shop/pulls?state=closed&sort=updated&direction=desc&per_page=30'] = () => json([])
        await poll.tick()
        // Long conflicting and failing, which polls without a token couldn't tell.
        await withToken()
        open = [pr(1, {mergeStateStatus: 'DIRTY'}), pr(2, {reviewDecision: 'CHANGES_REQUESTED', reviews: {nodes: [{id: 'R1'}]}, commits: {nodes: [{commit: {statusCheckRollup: {state: 'FAILURE'}}}]}})]
        await minuteOn()
        expect(changes).toEqual([])
        open = [pr(1, {mergeStateStatus: 'CLEAN'}), pr(2, {reviewDecision: 'CHANGES_REQUESTED', reviews: {nodes: [{id: 'R1'}]}, commits: {nodes: [{commit: {statusCheckRollup: {state: 'FAILURE'}}}]}})]
        await minuteOn()
        expect(changes.map(c => c.key)).toEqual(['you/shop#1 ready sha1a'])
    })

    it("polls now when the owner asks, whenever it last did, but not past GitHub's holds (ORR-534)", async () => {
        await withToken()
        open = [pr(1)]
        await poll.tick()
        expect(asked).toHaveLength(1)
        // Not due for a minute, but asked for.
        now += 5_000
        open = [pr(1, {mergeStateStatus: 'DIRTY'})]
        expect(await poll.pollNow()).toEqual(new Map())
        expect(asked).toHaveLength(2)
        expect(changes.map(c => c.kind)).toEqual(['conflicting'])
        // Two asks at once share one pass.
        now += 5_000
        await Promise.all([poll.pollNow(), poll.pollNow()])
        expect(asked).toHaveLength(3)
        // A refused token holds it, and says why.
        refuse = true
        now += 5_000
        await poll.pollNow()
        const held = await poll.pollNow()
        expect(held.get('you/shop')).toMatch(/turned down the GITHUB_TOKEN secret/)
        expect(asked).toHaveLength(4)
    })

    it('polls a repo without a token at most once a minute when asked, saying when it can again (ORR-534)', async () => {
        rest['/repos/you/shop/pulls?state=open&per_page=100'] = () => json([])
        rest['/repos/you/shop/pulls?state=closed&sort=updated&direction=desc&per_page=30'] = () => json([])
        await poll.pollNow()
        expect(asked).toHaveLength(2)
        now += 30_000
        expect((await poll.pollNow()).get('you/shop')).toBe('Read without a token a moment ago: it can be polled again at 10:01 UTC (a GITHUB_TOKEN secret lifts this)')
        expect(asked).toHaveLength(2)
        now += 30_000
        await poll.pollNow()
        expect(asked).toHaveLength(4)
        // And the page reads what it got, rather than asking GitHub a third time.
        asked = []
        expect((await pulls.all()).repos).toMatchObject([{repo: 'you/shop', token: false, checked_at: '2026-10-29T10:01:00.000Z'}])
        expect(asked).toEqual([])
    })

    it('lets go of a repo nobody points at any more', async () => {
        await withToken()
        open = [pr(1)]
        await poll.tick()
        await store.updateProject('shop', {repo: 'https://gitlab.com/you/shop'}, me)
        await minuteOn()
        expect(await store.db.all('SELECT * FROM pull_states')).toEqual([])
        expect(await store.db.all('SELECT * FROM pull_repos')).toEqual([])
    })

    it('reads no news in a state it can\'t tell', () => {
        const was = {state: 'conflicting' as const, checks: null, review: null, merged: 0, closed: 0}
        const now = {number: 1, title: '', url: '', body: '', branch: '', base: '', author: '', draft: false, head_sha: 's', review: null, review_id: null,
            checks: null, merged: false, closed: false, merge_sha: null, closed_by: null, created_at: '', updated_at: ''}
        expect(changesOf(was, {...now, state: null})).toEqual([])
        expect(changesOf(was, {...now, state: 'checking'})).toEqual([])
        expect(changesOf(was, {...now, state: 'blocked'})).toEqual([])
        expect(changesOf(undefined, {...now, state: 'behind'})).toEqual(['behind'])
    })
})
