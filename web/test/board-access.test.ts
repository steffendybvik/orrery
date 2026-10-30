import {readdirSync, statSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {PERMISSIONS} from '#shared/permissions'
import {notFound} from '../server/utils/input'
import type {Store as StoreType} from '../server/utils/store'
import {storeSetup} from './store-setup'

// A board's holder and members (ORR-654): the store's side, and the one check on every write against a real store,
// with the route's h3 helpers (Nitro auto-imports) stood in for. The write routes are read from the file tree, so a new
// one fails here until the permissions table classes it.
type Event = {method: string, path: string, headers: Record<string, string>}
let store: StoreType
let checkBoards: (event: Event) => Promise<void>
let boardsHeard: (event: Event, projects: string[]) => Promise<string[]>

const owner = {name: 'skoll', owner: true}
let sessionsNow: {id: string, person?: string, started?: {launch: string}}[] = []
const claude = {name: 'claude', owner: false}
const hati = {name: 'hati', owner: false}

beforeEach(async () => {
    ({store} = await storeSetup())
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('sessionName', (name: string | undefined) => name)
    vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
    vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
    vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
    vi.stubGlobal('decoded', (part: string) => decodeURIComponent(part))
    vi.stubGlobal('EXTERNAL', 'external')
    vi.stubGlobal('sessionNow', (id: string) => sessionsNow.find(s => s.id === id))
    vi.stubGlobal('listSessions', () => sessionsNow)
    vi.resetModules()
    const board = await import('../server/utils/board')
    checkBoards = board.checkBoards as unknown as typeof checkBoards
    boardsHeard = board.boardsHeard as unknown as typeof boardsHeard
    await store.nameOwner({name: 'Skoll'})
    await store.createProject({name: 'cellar', key: 'CEL'}, owner)
})

afterEach(() => vi.unstubAllGlobals())

/** The status a request gets from the check, or 200. */
const answer = (method: string, path: string, headers: Record<string, string>) => checkBoards({method, path, headers}).then(() => 200, (error: {statusCode: number}) => error.statusCode)
const route = (line: string) => {
    const [method, path] = line.split(' ') as [string, string]
    return {method, path: path.replace(/:[a-z]+/g, name => ({':project': 'greenhouse', ':issue': 'GRE-1'})[name] ?? '7')}
}
const asHati = {'orrery-actor': 'claude', 'orrery-person': 'hati'}

describe('a board', () => {
    it('is held by the owner, from when they name themselves or it was made after', async () => {
        expect(await store.members('greenhouse')).toMatchObject([{person: 'skoll', name: 'Skoll', role: 'owner'}])
        await store.nameOwner({name: 'Sköll Fenrisson'}, owner)
        expect(await store.members('greenhouse')).toMatchObject([{person: 'skoll_fenrisson', role: 'owner'}])
    })

    it('made by a member is theirs, and the owner gets it if they go', async () => {
        await store.addPerson({name: 'Hati'})
        await store.createProject({name: 'attic', key: 'ATT'}, hati, 'hati')
        expect(await store.members('attic')).toMatchObject([{person: 'hati', role: 'owner'}])
        await store.addMember('greenhouse', {person: 'hati'}, owner)
        await store.removePerson('hati', owner)
        expect(await store.members('attic')).toMatchObject([{person: 'skoll', role: 'owner'}])
        expect(await store.members('greenhouse')).toMatchObject([{person: 'skoll', role: 'owner'}])
    })

    it("says who's on it through its holder or the owner, never an agent", async () => {
        await store.addPerson({name: 'Hati'})
        await store.addPerson({name: 'Mani'})
        await store.createProject({name: 'attic', key: 'ATT'}, hati, 'hati')
        await expect(store.addMember('attic', {person: 'mani'}, claude)).rejects.toMatchObject({statusCode: 403, data: {permission: 'members.write'}})
        await expect(store.addMember('greenhouse', {person: 'mani'}, hati)).rejects.toMatchObject({statusCode: 403})
        expect(await store.addMember('attic', {person: 'mani'}, hati)).toMatchObject({person: 'mani', role: 'member'})
        expect(await store.addMember('attic', {person: 'mani'}, owner)).toMatchObject({person: 'mani', role: 'member'})
        await expect(store.removeMember('attic', 'hati', owner)).rejects.toMatchObject({statusCode: 400})
        await store.removeMember('attic', 'mani', hati)
        expect(await store.onBoard('attic', 'mani')).toBe(false)
        await expect(store.addMember('attic', {person: 'nobody'}, owner)).rejects.toMatchObject({statusCode: 404})
    })

    it('goes with its members when deleted', async () => {
        await store.deleteProject('cellar', owner)
        await expect(store.members('cellar')).rejects.toMatchObject({statusCode: 404})
    })
})

describe('on a one-person orrery', () => {
    it('lets every write by, a route nobody has classed included', async () => {
        for (const p of PERMISSIONS) for (const line of p.routes) {
            const {method, path} = route(line)
            expect(await answer(method, path, {'orrery-actor': 'claude'}), line).toBe(200)
        }
        expect(await answer('POST', '/api/somewhere/else', {})).toBe(200)
        expect(await boardsHeard({method: 'GET', path: '/', headers: {}}, ['greenhouse', 'cellar'])).toEqual(['greenhouse', 'cellar'])
    })
})

describe('with more than one person', () => {
    beforeEach(async () => {
        await store.addPerson({name: 'Hati'})
        await store.addMember('greenhouse', {person: 'hati'}, owner)
    })

    it('classes every write route in the file tree', () => {
        const files = (dir: string): string[] => readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)])
        const named = new Set(PERMISSIONS.flatMap(p => p.routes))
        for (const file of files('server/api')) {
            const found = /^server(\/api\/.*)\.(post|put|patch|delete)\.ts$/.exec(file)
            if (!found) continue
            const path = found[1]!.replace(/\/index$/, '').replace(/\[([^\]]+)\]/g, ':$1')
            expect(named.has(`${found[2]!.toUpperCase()} ${path}`), `${file} isn't in the permissions table: give it a row with a member cell`).toBe(true)
        }
    })

    it("refuses a member's agent every route on a board they aren't on", async () => {
        for (const p of PERMISSIONS) for (const line of p.routes.filter(r => r.includes(':project'))) {
            const {method, path} = route(line.replace(':project', 'cellar'))
            expect(await answer(method, path, asHati), line).toBe(404)
        }
    })

    it("lets them on a board they're on what their column says, and refuses the rest", async () => {
        for (const p of PERMISSIONS) {
            const lines = p.member.routes ?? p.routes
            const {level, check} = p.member
            const passes = (level === 'free' || level === 'limited') && check !== 'boardHolder' && check !== 'ownSession'
            for (const line of p.routes) {
                const {method, path} = route(line)
                const anotherRow = PERMISSIONS.some(q => q !== p && q.routes.includes(line) && ['free', 'limited'].includes(q.member.level) && (q.member.routes ?? q.routes).includes(line) && !q.member.check)
                const got = await answer(method, path, asHati)
                expect(got, `${p.id}: ${line}`).toBe((passes && lines.includes(line)) || anotherRow ? 200 : 403)
            }
        }
    })

    it('lets them stop, watch and Allow only their own sessions (ORR-658)', async () => {
        sessionsNow = [{id: 'hatis', person: 'hati', started: {launch: 'h1'}}, {id: 'skolls', person: 'skoll', started: {launch: 's1'}}]
        const asPerson = {'orrery-actor': 'hati'}
        for (const [mine, theirs] of [['sessions/hatis/stop', 'sessions/skolls/stop'], ['launches/h1/stop', 'launches/s1/stop'], ['launches/h1/extend', 'launches/s1/extend'], ['launches/h1/watch', 'launches/s1/watch'], ['launches/h1/allow', 'launches/s1/allow']]) {
            expect(await answer('POST', `/api/projects/greenhouse/${mine}`, asPerson), mine).toBe(200)
            expect(await answer('POST', `/api/projects/greenhouse/${theirs}`, asPerson), theirs).toBe(403)
        }
        expect(await answer('POST', '/api/projects/greenhouse/launches', asPerson)).toBe(403)
        sessionsNow = []
    })

    it('leaves what a board holds to its holder', async () => {
        await store.createProject({name: 'attic', key: 'ATT'}, hati, 'hati')
        expect(await answer('DELETE', '/api/projects/attic', asHati)).toBe(200)
        expect(await answer('POST', '/api/projects/attic/members', asHati)).toBe(200)
        expect(await answer('DELETE', '/api/projects/greenhouse', asHati)).toBe(403)
    })

    it('lets the owner, and their agents, by', async () => {
        for (const headers of [{'orrery-actor': 'skoll'}, {'orrery-actor': 'claude', 'orrery-person': 'skoll'}]) {
            expect(await answer('POST', '/api/projects/cellar/issues', headers)).toBe(200)
            expect(await answer('PUT', '/api/secrets/token', headers)).toBe(200)
        }
    })

    it('holds the chat and an untrusted session to their own guards, not this', async () => {
        expect(await answer('POST', '/api/projects/cellar/issues', {'orrery-chat': 'yes'})).toBe(200)
        expect(await answer('POST', '/api/projects/cellar/issues', {'orrery-untrusted': 'yes'})).toBe(200)
    })

    it('refuses what nobody has classed, however the path is written', async () => {
        expect(await answer('POST', '/api/somewhere/else', asHati)).toBe(403)
        expect(await answer('POST', '//api/somewhere/else', asHati)).toBe(403)
        expect(await answer('POST', '/api/somewhere/else', {'orrery-actor': 'claude'})).toBe(403)
        expect(await answer('POST', '/api/projects/cellar/issues?x=1', asHati)).toBe(404)
        expect(await answer('GET', '/api/projects/cellar/issues', asHati)).toBe(200)
    })

    it('gives a session naming nobody only reading, commenting and saying what it is doing', async () => {
        const nobody = {'orrery-actor': 'claude'}
        expect(await answer('POST', '/api/projects/cellar/issues/CEL-1/comments', nobody)).toBe(200)
        expect(await answer('POST', '/api/sessions', nobody)).toBe(200)
        expect(await answer('POST', '/api/projects/cellar/launches/running', nobody)).toBe(200)
        expect(await answer('POST', '/api/events/log', {})).toBe(200)
        expect(await answer('GET', '/api/projects/cellar/issues', nobody)).toBe(200)
        expect(await answer('POST', '/api/projects/cellar/issues', nobody)).toBe(409)
        expect(await answer('PATCH', '/api/projects/cellar/issues/CEL-1', nobody)).toBe(409)
        expect(await answer('PATCH', '/api/projects/cellar/issues', nobody)).toBe(409)
        expect(await answer('POST', '/api/projects', nobody)).toBe(409)
        expect(await answer('POST', '/api/uploads', {'orrery-actor': 'claude', 'orrery-person': 'nobody'})).toBe(409)
    })

    it('has a session hear only the boards its person is on', async () => {
        const hearing = (headers: Record<string, string>, projects = ['greenhouse', 'cellar']) => boardsHeard({method: 'GET', path: '/', headers}, projects)
        expect(await hearing(asHati)).toEqual(['greenhouse'])
        expect(await hearing({'orrery-actor': 'claude', 'orrery-person': 'skoll'})).toEqual(['greenhouse', 'cellar'])
        await expect(hearing({'orrery-actor': 'claude'})).rejects.toMatchObject({statusCode: 409})
        expect(await hearing({'orrery-untrusted': 'yes'})).toEqual(['greenhouse', 'cellar'])
    })

    it('refuses moving an issue to a board its person is not on', async () => {
        const {needsBoard} = await import('../server/utils/board') as unknown as {needsBoard: (event: Event, project: string) => Promise<void>}
        const event = {method: 'PATCH', path: '/', headers: asHati}
        await expect(needsBoard(event, 'greenhouse')).resolves.toBeUndefined()
        await expect(needsBoard(event, 'cellar')).rejects.toMatchObject({statusCode: notFound('').statusCode})
    })
})
