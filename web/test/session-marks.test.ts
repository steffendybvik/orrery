import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Store as StoreType} from '../server/utils/store'
import {storeSetup} from './store-setup'

// `Orrery-Chat` and `Orrery-Untrusted` say which of the owner's sessions a write comes from, and nothing checks them. With a
// credential that's someone else's they count for nothing, so a member's agent can't add one to step round the board
// check and the owner's alone rows (ORR-814). These use the real `chatWrite` and `untrustedWrite`, which other tests stub.
type Event = {method: string, path: string, headers: Record<string, string>, context: Record<string, unknown>}
let store: StoreType
let chatWrite: (event: Event) => boolean
let untrustedWrite: (event: Event) => boolean
let checkBoards: (event: Event) => Promise<void>
let authorize: (event: Event, id: string) => Promise<unknown>

const owner = {name: 'skoll', owner: true}
const MEMBER = {person: 'hati', owner: false, via: 'agent'}
const OWNER = {person: 'skoll', owner: true, via: 'agent'}
const MARKS = [{'orrery-chat': 'yes'}, {'orrery-untrusted': 'yes'}]

const asking = (who: unknown, headers: Record<string, string>, method = 'POST', path = '/api/projects/cellar/issues'): Event =>
    ({method, path, headers: {'orrery-actor': 'claude', ...headers}, context: who ? {who} : {}})
const status = (done: Promise<unknown>) => done.then(() => 200, (error: {statusCode: number}) => error.statusCode)

beforeEach(async () => {
    ({store} = await storeSetup())
    const fail = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})
    vi.stubGlobal('getHeader', (event: Event, name: string) => event.headers[name])
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('sessionName', (name: string | undefined) => name)
    vi.stubGlobal('conflict', fail(409))
    vi.stubGlobal('decoded', (part: string) => decodeURIComponent(part))
    vi.stubGlobal('sessionNow', () => undefined)
    vi.stubGlobal('listSessions', () => [])
    // orrery knows this session as the owner's chat, and that one as an untrusted schedule's.
    vi.stubGlobal('chatSession', (id: string) => id === 'owners-chat')
    vi.stubGlobal('untrustedSession', (id: string) => id === 'owners-untrusted')
    vi.resetModules()
    ;({chatWrite} = await import('../server/utils/chats') as unknown as {chatWrite: typeof chatWrite})
    ;({untrustedWrite} = await import('../server/utils/untrusted') as unknown as {untrustedWrite: typeof untrustedWrite})
    vi.stubGlobal('chatWrite', chatWrite)
    vi.stubGlobal('untrustedWrite', untrustedWrite)
    vi.stubGlobal('actorOf', (await import('../server/utils/actor')).actorOf)
    ;({checkBoards} = await import('../server/utils/board') as unknown as {checkBoards: typeof checkBoards})
    ;({authorize} = await import('../server/utils/authorize') as unknown as {authorize: typeof authorize})
    await store.nameOwner({name: 'Skoll'})
    await store.createProject({name: 'cellar', key: 'CEL'}, owner)
    await store.addPerson({name: 'Hati'})
})

afterEach(() => vi.unstubAllGlobals())

describe("the chat's and an untrusted session's marks", () => {
    it("count for nothing on a member's credential, by header or by naming the session", () => {
        for (const event of [asking(MEMBER, {'orrery-chat': 'yes'}), asking(MEMBER, {'orrery-session': 'owners-chat'})]) expect(chatWrite(event)).toBe(false)
        for (const event of [asking(MEMBER, {'orrery-untrusted': 'yes'}), asking(MEMBER, {'orrery-session': 'owners-untrusted'})]) expect(untrustedWrite(event)).toBe(false)
    })

    it('still say which session it is on the owner\'s credential, and with login off', () => {
        for (const who of [OWNER, undefined]) {
            expect(chatWrite(asking(who, {'orrery-chat': 'yes'}))).toBe(true)
            expect(chatWrite(asking(who, {'orrery-session': 'owners-chat'}))).toBe(true)
            expect(untrustedWrite(asking(who, {'orrery-untrusted': 'yes'}))).toBe(true)
            expect(untrustedWrite(asking(who, {'orrery-session': 'owners-untrusted'}))).toBe(true)
        }
    })

    it("don't get a member off the board check on a board they aren't on", async () => {
        for (const headers of MARKS) expect(await status(checkBoards(asking(MEMBER, headers)))).toBe(404)
    })

    it("don't get a member's agent what the chat may and they may not", async () => {
        for (const headers of MARKS) {
            for (const path of ['/api/egress', '/api/chats/abc/replies', '/api/events/log/1/resolve']) expect(await status(checkBoards(asking(MEMBER, headers, 'POST', path))), path).toBe(403)
            expect(await status(authorize(asking(MEMBER, headers), 'chats.reply'))).toBe(403)
        }
    })

    it('leave the owner\'s chat what it may', async () => {
        await expect(authorize(asking(OWNER, {'orrery-chat': 'yes'}), 'chats.reply')).resolves.toBeTruthy()
    })
})
