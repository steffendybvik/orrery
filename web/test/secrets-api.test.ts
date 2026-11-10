import {beforeEach, describe, expect, it, vi} from 'vitest'
import {Secrets} from '../server/utils/secrets'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// Secrets' writes go through the Rust API when it's in front (ORR-1096): already sealed, as the key stays here, so the
// API is the one writer of `secrets` and `secret_uses`, and nothing is written to the database here.
const sent: {method: string, path: string, body: unknown, actor: unknown, always: unknown}[] = []
let inFront = true
vi.mock('../server/utils/api-router', () => ({
    writeToApi: async (method: string, path: string, body: unknown, actor: unknown, opts: {always?: boolean} = {}) => {
        if (!inFront) return undefined
        sent.push({method, path, body, actor, always: opts.always})
        return {reply: null}
    },
}))

const OWNER = {name: 'skoll', owner: true}
const VALUE = 'sk_live_abcdef123456'
let store: Store
let secrets: Secrets

beforeEach(async () => {
    sent.length = 0
    inFront = true
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO'})
    const send = (async () => new Response('{}', {status: 200})) as typeof fetch
    secrets = new Secrets(store, () => 'a long random test key', () => {}, send)
})

const count = async (table: string) => (await store.db.get<{n: number}>(`SELECT COUNT(*) AS n FROM ${table}`))!.n

describe("secrets' writes through the Rust API (ORR-1096)", () => {
    it('sends the sealed row there as orrery, never the value, and writes nothing here', async () => {
        // Kept here first, so `get` after the write has a row to read, as the API's would.
        inFront = false
        await secrets.set('STRIPE_KEY', {value: VALUE, hosts: ['api.stripe.com']}, OWNER)
        inFront = true
        const before = await store.db.get<{value: string}>('SELECT value FROM secrets')
        await secrets.set('STRIPE_KEY', {value: VALUE, hosts: ['api.stripe.com'], projects: ['shop']}, OWNER)
        await secrets.narrow('STRIPE_KEY', {projects: ['shop']}, OWNER)
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['PUT /api/secrets/STRIPE_KEY/sealed', 'PUT /api/secrets/STRIPE_KEY/sealed'])
        expect(sent.every(s => s.always === true && (s.actor as {name: string}).name === 'orrery')).toBe(true)
        expect(sent[0]!.body).toMatchObject({last4: '3456', hosts: ['api.stripe.com'], projects: ['shop'], created_by: 'skoll', owned: true})
        expect(JSON.stringify(sent)).not.toContain(VALUE)
        expect((await store.db.get<{value: string, projects: string | null}>('SELECT value, projects FROM secrets'))).toEqual({...before, projects: null})
    })

    it("sends egress's and orrery's own uses there, orrery's to be kept to the latest", async () => {
        inFront = false
        await secrets.set('STRIPE_KEY', {value: VALUE, hosts: ['api.stripe.com']}, OWNER)
        inFront = true
        await secrets.egress({url: 'https://api.stripe.com/v1/charges?key={{secret:STRIPE_KEY}}', project: 'shop'}, {name: 'claude', owner: false})
        await secrets.own('https://api.stripe.com/v1/me', 'STRIPE_KEY', 'shop')
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['POST /api/secrets/STRIPE_KEY/uses', 'POST /api/secrets/STRIPE_KEY/uses'])
        expect(sent[0]!.body).toMatchObject({method: 'GET', host: 'api.stripe.com', path: '/v1/charges', project: 'shop', issue: null, status: 200, error: null, created_by: 'claude'})
        expect(sent[0]!.body).not.toHaveProperty('keep')
        expect(sent[1]!.body).toMatchObject({created_by: 'orrery', keep: expect.any(Number)})
        expect(await count('secret_uses')).toBe(0)
    })

    it('deletes there, and writes everything here without the API', async () => {
        inFront = false
        await secrets.set('STRIPE_KEY', {value: VALUE, hosts: ['api.stripe.com']}, OWNER)
        await secrets.own('https://api.stripe.com/v1/me', 'STRIPE_KEY', 'shop')
        expect([await count('secrets'), await count('secret_uses')]).toEqual([1, 1])
        inFront = true
        await secrets.delete('STRIPE_KEY', OWNER)
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['DELETE /api/secrets/STRIPE_KEY/sealed'])
        expect([await count('secrets'), await count('secret_uses')]).toEqual([1, 1])
        inFront = false
        await secrets.delete('STRIPE_KEY', OWNER)
        expect([await count('secrets'), await count('secret_uses')]).toEqual([0, 0])
    })
})
