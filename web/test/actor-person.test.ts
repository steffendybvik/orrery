import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Store} from '../server/utils/store'
import type {Store as StoreType} from '../server/utils/store'
import {storeSetup} from './store-setup'

// Whose a request is (ORR-653): `actorOf` from the headers, against a real store, and the refusal for a session that
// can't say. Each request is worked out afresh from what it sends, so an orrery restart or a `/clear`, which only
// changes what's in memory and the session's id, changes nothing. The route's h3 helpers are Nitro auto-imports, stood in for here.
type Event = {headers: Record<string, string>}
let store: StoreType
let personOf: typeof import('../server/utils/actor').personOf
let needsPerson: typeof import('../server/utils/actor').needsPerson

const asking = (headers: Record<string, string>) => ({headers}) as never

beforeEach(async () => {
    ({store} = await storeSetup())
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('sessionName', (name: string | undefined) => name)
    vi.stubGlobal('untrustedWrite', (event: Event) => event.headers['orrery-untrusted'] === 'yes')
    vi.stubGlobal('chatWrite', (event: Event) => event.headers['orrery-chat'] === 'yes')
    vi.stubGlobal('conflict', (message: string) => Object.assign(new Error(message), {statusCode: 409}))
    vi.resetModules()
    ;({personOf, needsPerson} = await import('../server/utils/actor'))
    await store.nameOwner({name: 'Skoll'})
})

afterEach(() => vi.unstubAllGlobals())

const session = {'orrery-actor': 'claude', 'orrery-session': 'window-a'}

describe('on a one-person orrery', () => {
    it("a session is the owner's, with nothing to set", async () => {
        expect(await personOf(asking(session))).toBe('skoll')
        await expect(needsPerson(asking(session))).resolves.toBeUndefined()
    })
})

describe('with more than one person', () => {
    beforeEach(() => store.addPerson({name: 'Hati'}).then(() => undefined))

    it('a session resolves to the person it names', async () => {
        expect(await personOf(asking({...session, 'orrery-person': 'hati'}))).toBe('hati')
        await expect(needsPerson(asking({...session, 'orrery-person': 'hati'}))).resolves.toBeUndefined()
    })

    it('keeps its person through a restart and a /clear', async () => {
        // A new id for the window, and a store made anew over the same database.
        const again = new Store(store.db)
        vi.stubGlobal('useStore', () => again)
        expect(await personOf(asking({'orrery-actor': 'claude', 'orrery-session': 'window-b', 'orrery-person': 'hati'}))).toBe('hati')
    })

    it.each([
        ['nobody', {}, 'names nobody'],
        ['somebody unknown', {'orrery-person': 'fenrir'}, '"fenrir" isn\'t anyone'],
    ])('a session naming %s is refused, and told how to set it', async (_, named, says) => {
        expect(await personOf(asking({...session, ...named}))).toBeUndefined()
        const refused = needsPerson(asking({...session, ...named}))
        await expect(refused).rejects.toMatchObject({statusCode: 409})
        await expect(refused).rejects.toThrow(says)
        await expect(refused).rejects.toThrow('ORRERY_PERSON')
    })

    it('a removed person\'s session is refused', async () => {
        await store.addPerson({name: 'Fenrir'})
        await store.removePerson('hati', {name: 'skoll', owner: true})
        await expect(needsPerson(asking({...session, 'orrery-person': 'hati'}))).rejects.toMatchObject({statusCode: 409})
    })

    it("the owner, and their chat, are the owner's whatever they send", async () => {
        expect(await personOf(asking({'orrery-actor': 'skoll', 'orrery-person': 'hati'}))).toBe('skoll')
        expect(await personOf(asking({'orrery-actor': 'claude', 'orrery-chat': 'yes', 'orrery-person': 'hati'}))).toBe('skoll')
    })

    it('an untrusted session has no person, whatever it sends', async () => {
        expect(await personOf(asking({...session, 'orrery-untrusted': 'yes', 'orrery-person': 'hati'}))).toBeUndefined()
        expect(await personOf(asking({'orrery-actor': 'skoll', 'orrery-untrusted': 'yes'}))).toBeUndefined()
    })
})

describe('the guard on changing an issue', () => {
    it('holds PATCH on one issue and in bulk, and lets the rest by', async () => {
        vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
        const asked: string[] = []
        vi.stubGlobal('needsPerson', async (event: {path: string}) => void asked.push(event.path))
        vi.stubGlobal('getRequestURL', (event: {path: string}) => new URL(event.path, 'http://o'))
        const guard = (await import('../server/middleware/person')).default as unknown as (event: {method: string, path: string}) => Promise<void>
        for (const [method, path] of [
            ['PATCH', '/api/projects/greenhouse/issues/GRE-1'],
            ['PATCH', '/api/projects/greenhouse/issues?x=1'],
            ['POST', '/api/projects/greenhouse/issues/GRE-1/comments'],
            ['PATCH', '/api/projects/greenhouse/issues/GRE-1/comments/3'],
            ['GET', '/api/projects/greenhouse/issues/GRE-1'],
            ['PATCH', '/api/projects/greenhouse'],
        ]) await guard({method: method!, path: path!})
        expect(asked).toEqual(['/api/projects/greenhouse/issues/GRE-1', '/api/projects/greenhouse/issues?x=1'])
    })
})
