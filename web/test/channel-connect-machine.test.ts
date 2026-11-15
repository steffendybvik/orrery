import {mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {connectIfAsked, machineName, saveKey} from '../../channel/connect-machine.mjs'
import {keyFor} from '../../channel/credentials.mjs'

// Connecting a machine to an orrery with login on, with no key to copy (ORR-1192).
const ORRERY = 'https://orrery.example.com'
const keysAt = () => join(mkdtempSync(join(tmpdir(), 'orrery-connect-')), 'orrery', 'keys.json')
const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}})

type Call = {url: string, body?: Record<string, unknown>, auth?: string}

/** A pretend orrery: `/api/settings` answers 200 only to `good`, and each `/api/machines/*` call takes the next answer. */
function server({good, answers}: {good: string, answers: Record<string, Response[]>}) {
    const calls: Call[] = []
    const fetch = async (url: string, init: RequestInit = {}) => {
        const headers = (init.headers ?? {}) as Record<string, string>
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        calls.push({url, body, auth: headers.Authorization})
        if (url.endsWith('/api/settings')) return headers.Authorization === `Bearer ${good}` ? json(200, {id: 'o1'}) : json(401, {message: 'Sign in'})
        const path = url.slice(url.indexOf('/api/machines/') + '/api/machines/'.length)
        const next = answers[path]?.shift()
        if (!next) throw new Error(`no answer left for ${path}`)
        return next
    }
    return {fetch, calls}
}

/** A clock that moves on as it sleeps, so polling takes no real time. */
function clock(start = Date.parse('2026-11-14T10:00:00Z')) {
    let t = start
    return {now: () => t, sleep: async (ms: number) => { t += ms }}
}

const quiet = () => {
    const said: string[] = []
    return {said, say: (line: string) => said.push(line)}
}

describe('connecting a machine from the install line', () => {
    it("redeems the line's code and keeps the key it gets", async () => {
        const file = keysAt()
        const {fetch, calls} = server({good: 'orrery_agent_new', answers: {connect: [json(201, {key: 'orrery_agent_new', person: {name: 'Ada'}})]}})
        const {said, say} = quiet()
        const opened: string[] = []
        const connected = await connectIfAsked(ORRERY, {env: {ORRERY_CODE: 'abc123'}, file, fetch, say, name: 'ada-mac', open: (u: string) => opened.push(u), ...clock()})
        expect(connected).toBe(true)
        expect(calls.find(c => c.url.endsWith('/api/machines/connect'))?.body).toEqual({name: 'ada-mac', code: 'abc123'})
        expect(keyFor(ORRERY, {env: {}, file})).toBe('orrery_agent_new')
        expect(statSync(file).mode & 0o777).toBe(0o600)
        expect(opened).toEqual([])
        expect(said).toEqual([`Connected ada-mac to ${ORRERY} as Ada. Its key is kept in ${file}.`])
    })

    it('asks, waits for Connect on the page, and keeps the key once it is pressed', async () => {
        const file = keysAt()
        const page = `${ORRERY}/connect/machine/r1`
        const {fetch, calls} = server({good: 'orrery_agent_new', answers: {
            connect: [json(201, {request: 'r1', secret: 's1', words: 'amber otter tide', url: page, expires_at: '2026-11-14T10:10:00Z'})],
            claim: [json(202, {waiting: true}), json(202, {waiting: true}), json(201, {key: 'orrery_agent_new', person: 'Ada'})],
        }})
        const {said, say} = quiet()
        const opened: string[] = []
        await connectIfAsked(ORRERY, {env: {}, file, fetch, say, name: 'ada-mac', open: (u: string) => opened.push(u), ...clock()})
        expect(said[0]).toBe(`To connect ada-mac, open ${page} and press Connect. Check it shows amber otter tide.`)
        expect(opened).toEqual([page])
        expect(calls.filter(c => c.url.endsWith('/claim')).map(c => c.body)).toEqual(Array(3).fill({request: 'r1', secret: 's1'}))
        expect(keyFor(ORRERY, {env: {}, file})).toBe('orrery_agent_new')
    })

    it("falls back to asking when the line's code is used up", async () => {
        const file = keysAt()
        const {fetch} = server({good: 'k', answers: {
            connect: [json(401, {message: 'That code has been used'}), json(201, {request: 'r1', secret: 's1', words: ['amber', 'otter'], url: `${ORRERY}/c`, expires_at: '2026-11-14T10:10:00Z'})],
            claim: [json(201, {key: 'orrery_agent_k'})],
        }})
        const {said, say} = quiet()
        await connectIfAsked(ORRERY, {env: {ORRERY_CODE: 'old'}, file, fetch, say, name: 'ada-mac', open: () => {}, ...clock()})
        expect(said.slice(0, 2)).toEqual(["This line's code has been used or has run out, so ada-mac asks to connect instead.", `To connect ada-mac, open ${ORRERY}/c and press Connect. Check it shows amber otter.`])
        expect(keyFor(ORRERY, {env: {}, file})).toBe('orrery_agent_k')
    })

    it('gives up with a clear message once the request runs out, keeping nothing', async () => {
        const file = keysAt()
        const waiting = Array.from({length: 400}, () => json(202, {waiting: true}))
        const {fetch} = server({good: 'k', answers: {connect: [json(201, {request: 'r1', secret: 's1', words: 'a b c', url: `${ORRERY}/c`, expires_at: '2026-11-14T10:10:00Z'})], claim: waiting}})
        await expect(connectIfAsked(ORRERY, {env: {}, file, fetch, say: () => {}, name: 'ada-mac', open: () => {}, ...clock()}))
            .rejects.toThrow("Nobody pressed Connect for ada-mac before its request ran out, so nothing was installed: run this line again to ask again")
        expect(waiting.length).toBe(400 - 300)
        expect(() => readFileSync(file)).toThrow()
    })

    it('stops at once when the orrery says the request is gone (410)', async () => {
        const {fetch} = server({good: 'k', answers: {connect: [json(201, {request: 'r1', secret: 's1', words: 'a b c', url: `${ORRERY}/c`, expires_at: '2026-11-14T10:10:00Z'})], claim: [json(202, {waiting: true}), json(410, {message: 'Expired'})]}})
        await expect(connectIfAsked(ORRERY, {env: {}, file: keysAt(), fetch, say: () => {}, name: 'ada-mac', open: () => {}, ...clock()}))
            .rejects.toThrow("ada-mac's request to connect was turned down or has run out, so nothing was installed: run this line again to ask again")
    })

    it('connects again when the orrery no longer takes the stored key, in its place', async () => {
        const file = keysAt()
        saveKey(ORRERY, 'orrery_agent_revoked', {file})
        saveKey('https://other.example', 'orrery_agent_other', {file})
        const {fetch, calls} = server({good: 'orrery_agent_new', answers: {connect: [json(201, {key: 'orrery_agent_new'})]}})
        const {said, say} = quiet()
        await connectIfAsked(`${ORRERY}/`, {env: {ORRERY_CODE: 'abc'}, file, fetch, say, name: 'ada-mac', open: () => {}, ...clock()})
        expect(calls[0].auth).toBe('Bearer orrery_agent_revoked')
        expect(said[0]).toBe(`${ORRERY}/ no longer takes this machine's key, so ada-mac connects again.`)
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({'https://other.example': 'orrery_agent_other', [ORRERY]: 'orrery_agent_new'})
    })

    it('puts a revoked ORRERY_KEY aside for the rest of the run', async () => {
        const env: Record<string, string> = {ORRERY_KEY: 'orrery_agent_revoked', ORRERY_CODE: 'abc'}
        const {fetch} = server({good: 'orrery_agent_new', answers: {connect: [json(201, {key: 'orrery_agent_new'})]}})
        await connectIfAsked(ORRERY, {env, file: keysAt(), fetch, say: () => {}, name: 'ada-mac', open: () => {}, ...clock()})
        expect(env.ORRERY_KEY).toBe('orrery_agent_new')
    })

    it('changes nothing when the orrery answers without a key (login off) or takes the one it has', async () => {
        const file = keysAt()
        const open = server({good: 'unused', answers: {}})
        const loginOff = async (url: string, init?: RequestInit) => url.endsWith('/api/settings') ? json(200, {id: 'o1'}) : open.fetch(url, init)
        expect(await connectIfAsked(ORRERY, {env: {}, file, fetch: loginOff, say: () => {}})).toBe(false)
        saveKey(ORRERY, 'orrery_agent_ok', {file})
        expect(await connectIfAsked(ORRERY, {env: {}, file, fetch: server({good: 'orrery_agent_ok', answers: {}}).fetch, say: () => {}})).toBe(false)
    })

    it('refuses an answer that is no agent key', async () => {
        const {fetch} = server({good: 'k', answers: {connect: [json(201, {key: 'orrery_person_x'})]}})
        await expect(connectIfAsked(ORRERY, {env: {ORRERY_CODE: 'c'}, file: keysAt(), fetch, say: () => {}, name: 'm', open: () => {}, ...clock()})).rejects.toThrow(/no agent key/)
    })

    it('says to make a key by hand on an orrery that cannot connect a machine', async () => {
        const {fetch} = server({good: 'k', answers: {connect: [json(404)]}})
        await expect(connectIfAsked(ORRERY, {env: {}, file: keysAt(), fetch, say: () => {}, name: 'm', open: () => {}, ...clock()})).rejects.toThrow(/make an agent key on its page/)
    })

    it("won't overwrite a keys file it can't read", () => {
        const file = keysAt()
        saveKey(ORRERY, 'orrery_agent_a', {file})
        writeFileSync(file, '{not json')
        expect(() => saveKey(ORRERY, 'orrery_agent_b', {file})).toThrow(/can't be read as JSON/)
        expect(readFileSync(file, 'utf8')).toBe('{not json')
    })

    it("names the machine by its host, without the network's part", () => {
        expect(machineName('Adas-MacBook-Pro.local')).toBe('Adas-MacBook-Pro')
        expect(machineName('build-01.home.example')).toBe('build-01')
        expect(machineName('build-01')).toBe('build-01')
        expect(machineName('x'.repeat(80))).toHaveLength(60)
        expect(machineName('  ')).toBe('this machine')
    })
})
