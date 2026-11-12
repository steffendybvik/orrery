import {createServer} from 'node:http'
import type {Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {apiForgotten, apiStarted} from '../server/utils/api-router'
import {databaseFresh, keepEnvironment, sizeOfDatabase} from '../server/utils/database-state'

// What the backups and App settings → Database ask of the database itself (ORR-1140): from the Rust API when it's
// there, so the Nuxt server reads none of it from the database; from the database here when it isn't.

const here = vi.hoisted(() => ({fresh: true, environment: '', size: 0}))
vi.mock('../server/utils/db', () => ({useDatabase: () => ({get: async () => ({size: here.size})})}))
vi.mock('../server/utils/restore', () => ({
    isFresh: async () => here.fresh,
    noteEnvironment: async (_db: unknown, environment: string) => {
        here.environment = environment
    },
}))

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
    Object.assign(here, {fresh: true, environment: '', size: 0})
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
    it('is read from the database here', async () => {
        here.fresh = false
        here.size = 4096
        expect(await databaseFresh()).toBe(false)
        expect(await sizeOfDatabase({kind: 'postgres', where: 'u@h/orrery'})).toEqual({size: 4096})
        await keepEnvironment('work')
        expect(here.environment).toBe('work')
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

    it('keeps the name it runs under through the API', async () => {
        apiStarted({url, token: 't'.repeat(24)})
        answer = {status: 204}
        await keepEnvironment('personal')
        expect(heard.map(h => `${h.method} ${h.url} ${h.body}`)).toEqual(['PUT /api/database/environment {"environment":"personal"}'])
        expect(here.environment).toBe('')
    })
})
