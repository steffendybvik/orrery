import {beforeEach, describe, expect, it, vi} from 'vitest'
import {commentOnPull} from '../server/utils/pull-comments'
import {Pulls} from '../server/utils/pulls'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// orrery's own words on an issue go through the Rust API when it's in front (ORR-1094): it's the one writer of
// `comments` then, so nothing is written to the database here, and the event each names is still told.
const sent: {method: string, path: string, body: unknown, actor: unknown, always: unknown}[] = []
let inFront = true
vi.mock('../server/utils/api-router', () => ({
    writeToApi: async (method: string, path: string, body: unknown, actor: unknown, opts: {always?: boolean} = {}) => {
        if (!inFront) return undefined
        sent.push({method, path, body, actor, always: opts.always})
        return {reply: {id: sent.length, body: (body as {body: string}).body, created_by: 'orrery'}}
    },
    // No API to read the settings from: the store answers.
    settingsNow: async (store: {settings: () => Promise<unknown>}) => await store.settings(),
}))

let store: Store
const count = async () => (await store.db.get<{n: number}>('SELECT COUNT(*) AS n FROM comments'))!.n

beforeEach(async () => {
    sent.length = 0
    inFront = true
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO'})
    await store.createIssue('shop', {title: 'Pay with cards'})
})

describe("orrery's own words through the Rust API (ORR-1094)", () => {
    it('sends each there as orrery, tells its event, and writes nothing here', async () => {
        const told: string[] = []
        store.happened = event => void told.push(event.type)
        expect((await store.systemComment('shop', 'SHO-1', 'Merged.', 'pr.merged')).body).toBe('Merged.')
        await store.systemNote('shop', 'SHO-1', 'Moved to Done.')
        await store.systemAsk('shop', 'SHO-1', 'Review it.', 'pr.risky_merged', 'decision')
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual([
            'POST /api/projects/shop/issues/SHO-1/said', 'POST /api/projects/shop/issues/SHO-1/said', 'POST /api/projects/shop/issues/SHO-1/comments',
        ])
        expect(sent.map(s => s.body)).toEqual([{body: 'Merged.', wakes: true}, {body: 'Moved to Done.'}, {body: 'Review it.', asks: 'decision'}])
        expect(sent.every(s => s.always === true && (s.actor as {name: string}).name === 'orrery')).toBe(true)
        expect(told).toEqual(['pr.merged', 'pr.risky_merged'])
        expect(await count()).toBe(0)
    })

    it('writes them here without the API', async () => {
        inFront = false
        await store.systemComment('shop', 'SHO-1', 'Merged.', 'pr.merged')
        await store.systemNote('shop', 'SHO-1', 'Moved to Done.')
        await store.systemAsk('shop', 'SHO-1', 'Review it.', 'pr.risky_merged')
        expect(sent).toEqual([])
        expect(await count()).toBe(3)
    })

    it("sends a merge's release, its cleared ask and its move to Done there too", async () => {
        inFront = false
        await store.updateProject('shop', {release_mode: 'own'})
        await store.createRelease('shop', {version: '1.0.0', branch: 'v1.0.0-rc.11'})
        await new Pulls(store, async () => { throw new Error('no GitHub here') }).remember('you/shop', ['shop'], {number: 12, title: 'x', url: 'u', branch: 'feat/sho-1-cards',
            base: 'v1.0.0-rc.11', author: 'claude', merged: true, closed: false, merged_at: '2026-11-07T07:02:30Z', created_at: '2026-11-07T06:55:00Z', updated_at: '2026-11-07T07:02:30Z', names: ['SHO-1']})
        const ask = await store.createComment('shop', 'SHO-1', {body: 'Does it look right?', asks: 'feedback'}, {name: 'claude', owner: false})
        inFront = true
        await commentOnPull(store, {project: 'shop', issue: 'SHO-1', repo: 'you/shop', kind: 'merged', key: 'you/shop#12 merged',
            pull: {number: 12, title: 'x', url: 'u', branch: 'feat/sho-1-cards', base: 'v1.0.0-rc.11', head_sha: 'a', merge_sha: 'b', closed_by: null, review_id: null}})
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual([
            'PATCH /api/projects/shop/issues/SHO-1', 'POST /api/projects/shop/issues/SHO-1/said', 'POST /api/notices/clear', 'PATCH /api/projects/shop/issues/SHO-1',
            'POST /api/projects/shop/issues/SHO-1/said',
        ])
        expect([sent[0]!.body, sent[2]!.body, sent[3]!.body]).toEqual([{release: '1.0.0'}, {ids: [ask.id]}, {status: 'done'}])
        const row = await store.db.get<{status: string, ships_in: string | null}>("SELECT status, ships_in FROM issues WHERE project = 'shop' AND id = 'SHO-1'")
        expect(row).toEqual({status: 'backlog', ships_in: null})
    })
})
