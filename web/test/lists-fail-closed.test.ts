import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// The routes that list across projects (sessions, chats, the Sessions page's work) read `listedSees`, where `undefined`
// means every workspace's rows. A read of the API that fails must leave anyone signed in with none of them, not all
// (ORR-1368): a moment's 5xx from the API once sent a member every workspace's sessions.
type Who = {person: string, owner: boolean, via: 'browser' | 'agent'}
type Handler = (event: unknown) => Promise<unknown>

const sessions = [{id: 's-mine', project: 'mine'}, {id: 's-theirs', project: 'theirs'}]
const chats = [{id: 'c-mine', project: 'mine'}, {id: 'c-theirs', project: 'theirs'}]
let answer: {id: string}[] | undefined
const eventOf = (who?: Who, query: Record<string, string> = {}) => ({context: {who}, query})

beforeEach(() => {
    answer = undefined
    vi.resetModules()
    vi.stubGlobal('defineEventHandler', (handler: Handler) => handler)
    vi.stubGlobal('readAsAsker', async () => answer)
    vi.stubGlobal('getHeader', () => undefined)
    vi.stubGlobal('getQuery', (event: {query: Record<string, string>}) => event.query)
    vi.stubGlobal('listSessions', (project?: string) => project ? sessions.filter(s => s.project === project) : sessions)
    vi.stubGlobal('listChats', () => chats)
    vi.stubGlobal('ownersOwn', () => {})
    vi.stubGlobal('sessionIds', (id: string) => [id])
    vi.stubGlobal('useStore', () => ({sessionWork: async (project: string) => ({project})}))
})
afterEach(() => vi.unstubAllGlobals())

async function routes() {
    const sees = await import('../server/utils/member-sees')
    vi.stubGlobal('listedSees', sees.listedSees)
    return {
        sessions: (await import('../server/api/sessions/index.get')).default as unknown as Handler,
        chats: (await import('../server/api/chats/index.get')).default as unknown as Handler,
        work: (await import('../server/api/sessions/work.get')).default as unknown as Handler,
    }
}

const people: [string, Who][] = [
    ['a member', {person: 'bo-fails', owner: false, via: 'browser'}],
    ["the server's owner", {person: 'sam-fails', owner: true, via: 'browser'}],
    ['an agent key', {person: 'kit-fails', owner: false, via: 'agent'}],
]

describe('a list across projects, when the API gives no answer', () => {
    for (const [who, person] of people) {
        it(`shows ${who} no session, chat or work`, async () => {
            const {sessions: listS, chats: listC, work} = await routes()
            expect(await listS(eventOf(person))).toEqual([])
            expect(await listC(eventOf(person))).toEqual([])
            expect(await work(eventOf(person))).toEqual({})
            expect(await work(eventOf(person, {projects: 'theirs'}))).toEqual({})
        })
    }

    it('shows the asker their own again once the API answers', async () => {
        const {sessions: listS} = await routes()
        const bo = eventOf({person: 'bo-back', owner: false, via: 'browser'})
        expect(await listS(bo)).toEqual([])
        answer = [{id: 'mine'}]
        expect(await listS(bo)).toEqual([{id: 's-mine', project: 'mine'}])
    })

    it('still lists every one with login off', async () => {
        const {sessions: listS} = await routes()
        expect(await listS(eventOf())).toEqual(sessions)
    })
})
