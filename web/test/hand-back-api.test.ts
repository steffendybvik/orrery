import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// What the local app hands back for a session, and what an action schedule moves, go through the Rust API when it's in
// front (ORR-1094): it's the one writer of `issues` and `comments` then, so nothing is written to the database here.
const sent: {method: string, path: string, body: unknown, actor: {name: string, owner: boolean}, always: unknown}[] = []
vi.mock('../server/utils/api-router', () => ({
    // No reads from the API: the store answers them here.
    readFromApi: async () => undefined,
    writeToApi: async (method: string, path: string, body: unknown, actor: {name: string, owner: boolean}, opts: {always?: boolean} = {}) => {
        // Which session works an issue is kept here, as the set-up needs it (ORR-1141's own tests cover its API call).
        if (path.endsWith('/worked-by')) return undefined
        sent.push({method, path, body, actor, always: opts.always})
        return {reply: null}
    },
}))

let store: Store

beforeEach(async () => {
    sent.length = 0
    store = new Store(testDb())
    await store.createProject({name: 'Greenhouse', key: 'GRE'})
    await store.createIssue('greenhouse', {title: 'Water the beds'})
    await store.updateIssue('greenhouse', 'GRE-1', {status: 'in-progress', assignee: 'claude'})
    await store.workedBy('greenhouse', 'GRE-1', 'w')
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('sessionIds', (id: string) => [id])
    vi.stubGlobal('sessionNow', () => ({name: 'Sköll'}))
    vi.resetModules()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe("the local app's own writes through the Rust API (ORR-1094)", () => {
    it("sends a session's hand-back there as its agent, and writes nothing here", async () => {
        const clearing = await import('../server/utils/clearing')
        expect(await clearing.letGo('greenhouse', 'w', 'overloaded')).toEqual(['GRE-1'])
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['PATCH /api/projects/greenhouse/issues/GRE-1', 'POST /api/projects/greenhouse/issues/GRE-1/comments'])
        expect(sent[0]!.body).toEqual({status: 'todo', assignee: null})
        expect((sent[1]!.body as {body: string}).body).toContain('(Sköll) had its turn cut off')
        expect(sent.every(s => s.always === true && s.actor.name === 'claude' && !s.actor.owner)).toBe(true)
        expect(await store.issue('greenhouse', 'GRE-1')).toMatchObject({status: 'in-progress', assignee: 'claude'})
        expect(await store.listComments('greenhouse', 'GRE-1')).toEqual([])
    })

    it("sends an action schedule's move there as the owner, and moves nothing here", async () => {
        const {Schedules} = await import('../server/utils/schedules')
        const me = {name: 'skoll', owner: true}
        const heard: import('#shared/happenings').OrreryEvent[] = []
        store.happened = event => void heard.push(event)
        const schedules = new Schedules(store)
        await schedules.create('greenhouse', {title: 'Merged', kind: 'action', on: 'pr.merged', column: 'done'}, me)
        await store.systemEvent('greenhouse', 'GRE-1', 'pr.merged')
        for (const event of heard.splice(0)) await schedules.hear(event, undefined, new Date())
        expect(sent.map(s => `${s.method} ${s.path}`)).toEqual(['PATCH /api/projects/greenhouse/issues/GRE-1', 'POST /api/projects/greenhouse/issues/GRE-1/said',
            // The run's record goes there too (ORR-1176).
            expect.stringMatching(/^POST \/api\/projects\/greenhouse\/schedules\/\d+\/runs$/)])
        expect((sent[0]!.body)).toEqual({status: 'done'})
        expect(sent[0]!.actor.owner).toBe(true)
        expect(sent[1]!.body).not.toHaveProperty('wakes')
        expect((await store.issue('greenhouse', 'GRE-1')).status).toBe('in-progress')
    })
})

