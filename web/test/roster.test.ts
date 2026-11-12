import {createServer} from 'node:http'
import type {Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {apiForgotten, apiStarted} from '../server/utils/api-router'
import {boardsOf, forgetRoster, holdsBoard, isPerson, isShared, issueNow, onBoard, ownerNow, personFor, projectNamed} from '../server/utils/roster'

// The checks on every request read the owner, the people and a board's members from the Rust API once it's there
// (ORR-1138), kept a moment, and never open the database for them; with no API, the store answers.

let server: Server
let url = ''
const asked: string[] = []
let people = [{id: 'skoll', role: 'owner'}, {id: 'hati', role: 'member'}, {id: 'gone', role: 'member', removed_at: '2026-01-01'}]
const BOARDS: Record<string, unknown[]> = {
    cellar: [{person: 'skoll', role: 'owner'}, {person: 'hati', role: 'member'}],
    attic: [{person: 'hati', role: 'owner'}],
}
const store = {ownerOf: vi.fn(), people: vi.fn(), members: vi.fn(), listProjects: vi.fn(), issue: vi.fn()}

beforeAll(async () => {
    vi.stubGlobal('databaseSetting', () => 'sqlite:test')
    vi.stubGlobal('useStore', () => store)
    server = createServer((req, res) => {
        const path = req.url ?? ''
        asked.push(path)
        const members = /^\/api\/projects\/([^/]+)\/members$/.exec(path)
        const reply = path === '/api/owner' ? {name: 'skoll', display: 'Skoll', named: true}
            : path === '/api/people' ? people
            : path === '/api/projects' ? [{id: 'cellar', key: 'CEL'}, {id: 'attic', key: 'ATT'}]
            : path === '/api/projects/cellar/issues/CEL-1' ? {proposal: 'pending', labels: ['external']}
            : members && BOARDS[members[1]!] ? BOARDS[members[1]!] : undefined
        res.writeHead(reply ? 200 : 404, {'Content-Type': 'application/json'})
        res.end(JSON.stringify(reply ?? {statusMessage: 'Not Found', message: 'none'}))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => {
    asked.length = 0
    people = [{id: 'skoll', role: 'owner'}, {id: 'hati', role: 'member'}, {id: 'gone', role: 'member', removed_at: '2026-01-01'}]
    forgetRoster()
    apiStarted({url, token: 't'})
})

afterEach(() => {
    apiStarted(null)
    apiForgotten()
    forgetRoster()
})

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllGlobals()
})

describe('the roster from the API', () => {
    it('reads the owner, the people and the boards from the API, not the store', async () => {
        expect((await ownerNow()).name).toBe('skoll')
        expect(await isShared()).toBe(true)
        expect(await isPerson('Hati')).toBe(true)
        expect(await isPerson('gone')).toBe(true)
        expect(await personFor('hati')).toBe('hati')
        expect(await personFor('gone')).toBeUndefined()
        expect(await onBoard('cellar', 'hati')).toBe(true)
        expect(await onBoard('nowhere', 'hati')).toBe(false)
        expect(await onBoard('nowhere', 'skoll')).toBe(true)
        expect(await holdsBoard('attic', 'hati')).toBe(true)
        expect(await holdsBoard('cellar', 'hati')).toBe(false)
        expect(await boardsOf('hati', ['cellar', 'attic', 'nowhere'])).toEqual(['cellar', 'attic'])
        expect(await projectNamed('cel')).toBe('cellar')
        expect(await projectNamed('pantry')).toBe('pantry')
        expect(await issueNow('cellar', 'CEL-1')).toEqual({proposal: 'pending', labels: ['external']})
        expect(await issueNow('cellar', 'CEL-2')).toBeNull()
        for (const read of Object.values(store)) expect(read).not.toHaveBeenCalled()
    })

    it('asks once for what a request asks over and over, and again once a write forgets it', async () => {
        await Promise.all([isShared(), isShared(), personFor('hati'), isPerson('hati')])
        expect(asked.filter(path => path === '/api/people')).toHaveLength(1)
        people = [{id: 'skoll', role: 'owner'}]
        expect(await isShared()).toBe(true)
        forgetRoster()
        expect(await isShared()).toBe(false)
        expect(asked.filter(path => path === '/api/people')).toHaveLength(2)
    })
})

describe('the roster with no API', () => {
    it('leaves it to the store, kept nowhere', async () => {
        apiStarted(null)
        store.ownerOf.mockResolvedValue({name: 'skoll', display: 'Skoll', named: true})
        store.people.mockResolvedValue([{id: 'skoll'}])
        expect(await isShared()).toBe(false)
        store.people.mockResolvedValue([{id: 'skoll'}, {id: 'hati'}])
        expect(await isShared()).toBe(true)
        expect(await personFor('nobody')).toBeUndefined()
        expect(asked).toEqual([])
    })
})
