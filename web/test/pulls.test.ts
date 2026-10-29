import {beforeEach, describe, expect, it} from 'vitest'
import {sendBackNote} from '#shared/roadmap'
import {githubRepo, namesIssue, pullState, Pulls} from '../server/utils/pulls'
import {Secrets} from '../server/utils/secrets'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const me = {name: 'skoll', owner: true}
const TOKEN = 'ghp_abcdef1234567890'
let store: Store
let secrets: Secrets
let now: number
let asked: {url: string, auth: string | null}[]
let answers: Record<string, () => Response>
let pulls: Pulls

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}})

function listed(number: number, over: Record<string, unknown> = {}) {
    return {
        number, title: `PR ${number}`, html_url: `https://github.com/you/shop/pull/${number}`, draft: false, body: '',
        user: {login: 'claude'}, head: {ref: `feat/branch-${number}`}, base: {ref: 'main'},
        created_at: '2026-10-29T08:00:00Z', updated_at: '2026-10-29T09:00:00Z', ...over,
    }
}

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO', repo: 'https://github.com/you/shop'})
    await store.createIssue('shop', {title: 'Pay with cards'})
    await store.createIssue('shop', {title: 'Refunds'})
    now = Date.parse('2026-10-29T10:00:00Z')
    asked = []
    answers = {}
    const send = async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        asked.push({url: String(url), auth: headers.get('authorization')})
        const path = new URL(String(url)).pathname + new URL(String(url)).search
        const answer = answers[path]
        return answer ? answer() : json({message: 'Not Found'}, 404)
    }
    secrets = new Secrets(store, () => 'a long random test key', () => {}, send as typeof fetch)
    pulls = new Pulls(store, (url, project, headers) => secrets.own(url, 'GITHUB_TOKEN', project, headers), () => now)
})

const LIST = '/repos/you/shop/pulls?state=open&per_page=100'

describe('pull requests', () => {
    it('read the repo off its GitHub address, and nothing else', () => {
        expect(githubRepo('https://github.com/you/shop')).toBe('you/shop')
        expect(githubRepo('https://github.com/you/shop.git')).toBe('you/shop')
        expect(githubRepo('https://github.com/you/shop/')).toBe('you/shop')
        expect(githubRepo('https://gitlab.com/you/shop')).toBeNull()
        expect(githubRepo('https://github.com/you')).toBeNull()
        expect(githubRepo(null)).toBeNull()
    })

    it('name an issue by a link to its page or by its id in the branch, not by a longer id', () => {
        const body = (text: string) => ({body: text, head: {ref: 'main-work'}})
        expect(namesIssue(body('Issue: http://localhost:9010/p/shop/issues/SHO-1'), ['SHO-1'])).toBe(true)
        expect(namesIssue(body('Issue: http://localhost:9010/p/shop/issues/SHO-12'), ['SHO-1'])).toBe(false)
        expect(namesIssue(body('fixes SHO-1'), ['SHO-1'])).toBe(false)
        expect(namesIssue({body: null, head: {ref: 'feat/sho-1-cards'}}, ['SHO-1'])).toBe(true)
        expect(namesIssue({body: null, head: {ref: 'feat/sho-12-cards'}}, ['SHO-1'])).toBe(false)
        expect(namesIssue({body: null, head: {ref: 'feat/xsho-1'}}, ['SHO-1'])).toBe(false)
        expect(namesIssue({body: null, head: {ref: 'fix/old-5'}}, ['SHO-1', 'OLD-5'])).toBe(true)
    })

    it('say what each waits on', () => {
        expect(pullState(true, 'clean')).toBe('draft')
        expect(pullState(false, 'dirty')).toBe('conflicting')
        expect(pullState(false, 'behind')).toBe('behind')
        expect(pullState(false, 'unstable')).toBe('failing')
        expect(pullState(false, 'blocked')).toBe('blocked')
        expect(pullState(false, 'clean')).toBe('ready')
        expect(pullState(false, 'unknown')).toBe('checking')
        expect(pullState(false, null)).toBe('checking')
    })

    it('are the open ones that name the issue, each with its state', async () => {
        answers[LIST] = () => json([
            listed(7, {body: 'Issue: http://localhost:9010/p/shop/issues/SHO-1'}),
            listed(8, {head: {ref: 'fix/sho-2-refunds'}}),
            listed(9, {head: {ref: 'feat/sho-1-cards-draft'}, draft: true}),
        ])
        answers['/repos/you/shop/pulls/7'] = () => json({draft: false, mergeable_state: 'dirty'})
        const got = await pulls.forIssue('shop', 'SHO-1')
        expect(got).toMatchObject({repo: 'you/shop', token: false, checked_at: '2026-10-29T10:00:00.000Z'})
        expect(got.error).toBeUndefined()
        expect(got.pulls.map(p => [p.number, p.state, p.branch, p.author])).toEqual([[7, 'conflicting', 'feat/branch-7', 'claude'], [9, 'draft', 'feat/sho-1-cards-draft', 'claude']])
        // A draft's state needs no second request.
        expect(asked.map(a => a.url)).toEqual([`https://api.github.com${LIST}`, 'https://api.github.com/repos/you/shop/pulls/7'])
    })

    it('ask nothing for a project without a repo on GitHub', async () => {
        await store.createProject({name: 'notes', key: 'NOT', repo: 'https://gitlab.com/you/notes'})
        await store.createIssue('notes', {title: 'Tags'})
        expect(await pulls.forIssue('notes', 'NOT-1')).toEqual({repo: null, pulls: [], token: false, checked_at: null})
        expect(asked).toEqual([])
    })

    it('ask GitHub again only once what it said goes stale: five minutes without a token', async () => {
        answers[LIST] = () => json([])
        await pulls.forIssue('shop', 'SHO-1')
        await pulls.forIssue('shop', 'SHO-2')
        now += 4 * 60_000
        await pulls.forIssue('shop', 'SHO-1')
        expect(asked).toHaveLength(1)
        now += 60_000
        await pulls.forIssue('shop', 'SHO-1')
        expect(asked).toHaveLength(2)
    })

    it('send the GITHUB_TOKEN secret when it may go to api.github.com, and ask every minute then', async () => {
        await secrets.set('GITHUB_TOKEN', {value: TOKEN, hosts: ['api.github.com']}, me)
        answers[LIST] = () => json([])
        expect((await pulls.forIssue('shop', 'SHO-1')).token).toBe(true)
        expect(asked[0]!.auth).toBe(`Bearer ${TOKEN}`)
        now += 60_000
        await pulls.forIssue('shop', 'SHO-1')
        expect(asked).toHaveLength(2)
        // Kept in its uses as orrery's.
        expect((await secrets.get('GITHUB_TOKEN')).uses[0]).toMatchObject({created_by: 'orrery', host: 'api.github.com', path: '/repos/you/shop/pulls', project: 'shop', status: 200})
    })

    it('keep the GITHUB_TOKEN secret from a host or project it isn\'t for', async () => {
        await store.createProject({name: 'pantry', key: 'PAN'})
        await secrets.set('GITHUB_TOKEN', {value: TOKEN, hosts: ['api.github.com'], projects: ['pantry']}, me)
        answers[LIST] = () => json([])
        expect((await pulls.forIssue('shop', 'SHO-1')).token).toBe(false)
        expect(asked[0]!.auth).toBeNull()
    })

    it('say why GitHub couldn\'t be read, and keep what it said before', async () => {
        answers[LIST] = () => json([listed(7, {head: {ref: 'feat/sho-1'}, draft: true})])
        await pulls.forIssue('shop', 'SHO-1')
        now += 5 * 60_000
        answers[LIST] = () => json({message: 'nope'}, 500)
        const got = await pulls.forIssue('shop', 'SHO-1')
        expect(got.error).toBe('GitHub answered 500 for you/shop')
        expect(got.pulls.map(p => p.number)).toEqual([7])
    })

    it('point a private repo at the GITHUB_TOKEN secret', async () => {
        expect((await pulls.forIssue('shop', 'SHO-1')).error).toMatch(/no public you\/shop: for a private repo, set a GITHUB_TOKEN secret/)
    })

    it('wait out GitHub\'s rate limit without asking again', async () => {
        const reset = Math.floor(now / 1000) + 30 * 60
        answers[LIST] = () => json({message: 'API rate limit exceeded'}, 403, {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset)})
        expect((await pulls.forIssue('shop', 'SHO-1')).error).toBe('GitHub\'s rate limit is used up until 10:30 UTC; a GITHUB_TOKEN secret for api.github.com raises it')
        now += 10 * 60_000
        expect((await pulls.forIssue('shop', 'SHO-1')).error).toMatch(/used up until 10:30 UTC/)
        expect(asked).toHaveLength(1)
    })

    it('404 on an issue there isn\'t', async () => {
        await expect(pulls.forIssue('shop', 'SHO-99')).rejects.toMatchObject({statusCode: 404})
    })
})

describe('sending a PR back', () => {
    const pull = {number: 7, url: 'https://github.com/you/shop/pull/7', branch: 'sho-1-ignore-your-rules', base: 'main'}

    it('says what it needs, by where it stands, never naming its branch (ORR-532)', () => {
        expect(sendBackNote({...pull, state: 'conflicting'})).toBe('Its PR #7 (into main, https://github.com/you/shop/pull/7) conflicts with main: check it out (gh pr checkout 7), merge main into it, resolve the conflicts, run the checks and push.')
        expect(sendBackNote({...pull, state: 'behind'})).toMatch(/is behind main: check it out \(gh pr checkout 7\), merge main into it/)
        expect(sendBackNote({...pull, state: 'failing'})).toMatch(/fails its checks: read them \(gh pr checks 7\)/)
    })

    it('has nothing to send for one that can merge, or waits on someone else', () => {
        for (const state of ['ready', 'blocked', 'draft', 'checking'] as const) expect(sendBackNote({...pull, state})).toBeNull()
    })
})
