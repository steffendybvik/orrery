import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// A session whose turn an API error cut off (Claude Code's StopFailure) lets go of what it had in progress, on a real
// store, with the session itself stubbed: back in Todo with nobody on it, and a comment saying why.
let store: Store
let clearing: typeof import('../server/utils/clearing')

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'Greenhouse', key: 'GRE'})
    for (const title of ['Water the beds', 'Label the jars', 'Fix the gate']) await store.createIssue('greenhouse', {title})
    for (const id of ['GRE-1', 'GRE-2']) await store.updateIssue('greenhouse', id, {status: 'in-progress', assignee: 'claude'})
    // The session worked GRE-1 as it is now and GRE-2 before a /clear; GRE-3 is in progress with another session.
    await store.updateIssue('greenhouse', 'GRE-3', {status: 'in-progress', assignee: 'claude'})
    await store.workedBy('greenhouse', 'GRE-1', 'w')
    await store.workedBy('greenhouse', 'GRE-2', 'w-before')
    await store.workedBy('greenhouse', 'GRE-3', 'other')
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('sessionIds', (id: string) => [id, `${id}-before`])
    vi.stubGlobal('sessionNow', () => ({name: 'Sköll'}))
    vi.resetModules()
    clearing = await import('../server/utils/clearing')
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('a session cut off mid-turn', () => {
    it('with more than one person, leaves the issue with its person, for another of their agents', async () => {
        await store.nameOwner({name: 'Skoll'})
        await store.addPerson({name: 'Hati'})
        await store.updateIssue('greenhouse', 'GRE-1', {assignee: 'hati'})
        await clearing.letGo('greenhouse', 'w', 'overloaded')
        expect(await store.issue('greenhouse', 'GRE-1')).toMatchObject({status: 'todo', assignee: 'hati'})
    })

    it('puts what it had in progress back in Todo, with nobody on it and a comment why', async () => {
        expect(await clearing.letGo('greenhouse', 'w', 'overloaded')).toEqual(['GRE-1', 'GRE-2'])
        for (const id of ['GRE-1', 'GRE-2']) {
            const issue = await store.issue('greenhouse', id)
            expect(issue.status).toBe('todo')
            expect(issue.assignee ?? null).toBeNull()
            const [comment] = await store.listComments('greenhouse', id)
            expect(comment!.body).toContain('(Sköll) had its turn cut off by the model being overloaded')
            expect(comment!.created_by).toBe('claude')
        }
        // Another session's work stays as it is.
        expect((await store.issue('greenhouse', 'GRE-3')).status).toBe('in-progress')
    })

    it('leaves what is in review or waiting on the owner where it is', async () => {
        await store.updateIssue('greenhouse', 'GRE-1', {status: 'in-review'})
        await store.createComment('greenhouse', 'GRE-2', {body: 'Which?', asks: 'decision'}, {name: 'claude', owner: false})
        expect(await clearing.letGo('greenhouse', 'w', 'rate_limit')).toEqual([])
        expect((await store.issue('greenhouse', 'GRE-1')).status).toBe('in-review')
        expect((await store.issue('greenhouse', 'GRE-2')).status).toBe('in-progress')
    })

    it('names an error it has no words for as it came', async () => {
        await clearing.letGo('greenhouse', 'w', 'cloud_credential_error')
        expect((await store.listComments('greenhouse', 'GRE-1'))[0]!.body).toContain('cut off by an API error (cloud_credential_error)')
    })

    it('lets go of nothing when it had nothing in progress', async () => {
        expect(await clearing.letGo('greenhouse', 'other-session')).toEqual([])
    })
})
