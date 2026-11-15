import {createServer} from 'node:http'
import type {Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {apiForgotten, apiStarted} from '../server/utils/api-router'
import {databaseFresh, sizeOfDatabase} from '../server/utils/database-state'

// What the start and `GET /api/machine` ask of the database itself (ORR-1140): from the Rust API, so the Nuxt server
// reads none of it from the database; with no API, the question fails (ORR-1135).

type Heard = {method: string, url: string, headers: Record<string, string | string[] | undefined>, body: string}

let server: Server
let url = ''
const heard: Heard[] = []
let answer: {status: number, body?: unknown} = {status: 200, body: {}}

beforeAll(async () => {
    vi.stubGlobal('useEventLog', () => ({note: () => {}}))
    vi.stubGlobal('databaseSetting', () => 'sqlite:test')
    vi.stubGlobal('useStore', () => ({relaying: async (run: () => Promise<void>) => await run(), changed: () => {}, told: () => {}, handOn: async () => {}, sayUrgent: async () => {}}))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    server = createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            heard.push({method: req.method ?? '', url: req.url ?? '', headers: req.headers, body})
            res.writeHead(answer.status, {'Content-Type': 'application/json'})
            res.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => {
    heard.length = 0
    answer = {status: 200, body: {}}
})

afterEach(() => {
    apiStarted(null)
    apiForgotten()
})

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('the database\'s state, with no API', () => {
    it('fails as an API that isn\'t running, reading nothing here', async () => {
        await expect(databaseFresh()).rejects.toMatchObject({statusCode: 503})
        await expect(sizeOfDatabase({kind: 'postgres', where: 'u@h/orrery'})).rejects.toMatchObject({statusCode: 503})
        // A SQLite file's size is read from the file, with no question to ask.
        expect(await sizeOfDatabase({kind: 'sqlite', where: '/nowhere/orrery.db'})).toEqual({})
        expect(heard).toEqual([])
    })
})

describe('the database\'s state, with the API there', () => {
    it('asks the API whether it\'s a new orrery\'s, as orrery', async () => {
        apiStarted({url, token: 't'.repeat(24)})
        answer = {status: 200, body: {fresh: false}}
        expect(await databaseFresh()).toBe(false)
        expect(heard.map(h => `${h.method} ${h.url}`)).toEqual(['GET /api/database'])
        expect(heard[0]!.headers).toMatchObject({'orrery-actor-name': 'orrery'})
    })

    it('takes a Postgres database\'s size from the API, and reads a SQLite file\'s itself', async () => {
        apiStarted({url, token: 't'.repeat(24)})
        answer = {status: 200, body: {fresh: true, size: 8331935}}
        expect(await sizeOfDatabase({kind: 'postgres', where: 'u@h/orrery'})).toEqual({size: 8331935})
        answer = {status: 200, body: {fresh: true}}
        expect(await sizeOfDatabase({kind: 'postgres', where: 'u@h/orrery'})).toEqual({})
        expect(await sizeOfDatabase({kind: 'sqlite', where: '/nowhere/orrery.db'})).toEqual({})
        expect(heard.map(h => `${h.method} ${h.url}`)).toEqual(['GET /api/database', 'GET /api/database'])
    })
})
