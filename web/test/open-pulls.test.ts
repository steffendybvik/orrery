import {beforeEach, describe, expect, it} from 'vitest'
import {issueIdsIn, Pulls} from '../server/utils/pulls'
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

describe('every open pull request', () => {
    it('reads the ids a PR names, its body\'s links first, as written', () => {
        expect(issueIdsIn({body: 'Issue: http://localhost:9010/p/shop/issues/SHO-2', head: {ref: 'feat/sho-1-cards'}})).toEqual(['SHO-2', 'SHO-1'])
        expect(issueIdsIn({body: 'fixes SHO-1', head: {ref: 'v1.0.0-rc.11'}})).toEqual([])
        expect(issueIdsIn({body: null, head: {ref: 'feat/sho-1-sho-1'}})).toEqual(['SHO-1'])
    })

    it('lists each repo once, with the issue each PR names, and without a token reads only the list', async () => {
        await store.createProject({name: 'till', key: 'TIL', repo: 'https://github.com/you/shop.git'})
        await store.createIssue('till', {title: 'Receipts'})
        await store.createProject({name: 'notes', key: 'NOT', repo: 'https://gitlab.com/you/notes'})
        answers[LIST] = () => json([
            listed(7, {head: {ref: 'feat/til-1-receipts'}}),
            listed(8, {body: 'Issue: http://localhost:9010/p/shop/issues/SHO-2', draft: true}),
            listed(9, {head: {ref: 'chore/bump'}}),
        ])
        const got = await pulls.all()
        expect(got.repos).toEqual([{repo: 'you/shop', projects: ['shop', 'till'], token: false, checked_at: '2026-10-29T10:00:00.000Z', open: 3, needs: 0}])
        expect(got.pulls.map(p => [p.number, p.state, p.issue?.id ?? null])).toEqual([[7, 'checking', 'TIL-1'], [8, 'draft', 'SHO-2'], [9, 'checking', null]])
        expect(got.pulls[0]!.issue).toEqual({project: 'till', id: 'TIL-1', title: 'Receipts'})
        expect(got.needs).toBe(0)
        expect(asked.map(a => a.url)).toEqual([`https://api.github.com${LIST}`])
    })

    it('with a token, reads each state, and puts those needing someone first, oldest first', async () => {
        await secrets.set('GITHUB_TOKEN', {value: TOKEN, hosts: ['api.github.com']}, me)
        answers[LIST] = () => json([
            listed(1, {created_at: '2026-10-27T08:00:00Z'}),
            listed(2, {created_at: '2026-10-29T08:00:00Z'}),
            listed(3, {created_at: '2026-10-28T08:00:00Z'}),
            listed(4, {created_at: '2026-10-26T08:00:00Z'}),
        ])
        answers['/repos/you/shop/pulls/1'] = () => json({mergeable_state: 'clean'})
        answers['/repos/you/shop/pulls/2'] = () => json({mergeable_state: 'dirty'})
        answers['/repos/you/shop/pulls/3'] = () => json({mergeable_state: 'behind'})
        answers['/repos/you/shop/pulls/4'] = () => json({mergeable_state: 'blocked'})
        const got = await pulls.all()
        expect(got.pulls.map(p => [p.number, p.state])).toEqual([[3, 'behind'], [2, 'conflicting'], [4, 'blocked'], [1, 'ready']])
        expect(got.needs).toBe(2)
        expect(got.repos[0]!.token).toBe(true)
        // Asked again within the minute, it's what GitHub said.
        await pulls.all()
        expect(asked).toHaveLength(5)
    })

    it('says why a repo couldn\'t be read, and asks nothing with no repo on GitHub', async () => {
        expect(await pulls.all()).toEqual({pulls: [], open: 0, needs: 0, repos: [{repo: 'you/shop', projects: ['shop'], token: false, checked_at: '2026-10-29T10:00:00.000Z', open: 0, needs: 0, error: expect.stringContaining('GitHub has no public you/shop')}]})
        await store.updateProject('shop', {repo: null})
        asked = []
        expect(await pulls.all()).toEqual({pulls: [], open: 0, needs: 0, repos: []})
        expect(asked).toEqual([])
    })
})
