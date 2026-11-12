import {beforeEach, describe, expect, it, vi} from 'vitest'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// The session bookkeeping's reads and its one write go to the Rust API when it's set up (ORR-1141), and whether a
// session is there to hear is still this server's.
const asked: string[] = []
let replies: Record<string, unknown> = {}
vi.mock('../server/utils/api-router', () => ({
    readFromApi: async (path: string) => {
        asked.push(`GET ${path}`)
        return replies[path]
    },
    writeToApi: async (method: string, path: string, body: unknown) => {
        asked.push(`${method} ${path} ${JSON.stringify(body)}`)
        return {reply: null}
    },
}))

let store: Store

beforeEach(async () => {
    asked.length = 0
    replies = {}
    store = new Store(testDb())
    await store.createProject({name: 'Greenhouse', key: 'GRE'})
    await store.createIssue('greenhouse', {title: 'Water the beds'})
})

const workers = '/api/projects/greenhouse/issues/GRE-1/workers'

describe('the sessions’ bookkeeping through the Rust API (ORR-1141)', () => {
    it('finds the session holding an issue above from the API, keeping only one that hears', async () => {
        replies[workers] = [
            {issue: 'GRE-1', started: false, worker: null},
            {issue: 'GRE-0', started: true, worker: 'gone'},
            {issue: 'GRE-00', started: true, worker: 'here'},
        ]
        store.hears = (_project, session) => session === 'here'
        expect(await store.heldAbove('greenhouse', 'GRE-1')).toEqual({parent: 'GRE-00', holder: 'here'})
        expect(await store.heldAbove('greenhouse', 'GRE-1', 'here')).toBeNull()
        replies[workers] = [{issue: 'GRE-1', started: true, worker: 'here'}]
        expect(await store.takenFrom('greenhouse', 'GRE-1', 'other')).toBe('here')
        expect(await store.takenFrom('greenhouse', 'GRE-1', 'here')).toBeNull()
    })

    it('ties an issue to a session through the API, and writes nothing here', async () => {
        replies[workers] = [{issue: 'GRE-1', started: false, worker: null}]
        await store.workedBy('greenhouse', 'GRE-1', 'w')
        expect(asked).toContain('POST /api/projects/greenhouse/issues/GRE-1/worked-by {"session":"w"}')
        expect(await store.all('SELECT * FROM issue_sessions')).toEqual([])
    })

    it('reads what a session works on, and what waits for it, from the API', async () => {
        replies['/api/projects/greenhouse/issue-sessions?sessions=a,b'] = {issues: [{id: 'GRE-1', kind: 'started'}], waiting: false, waiting_for: false}
        expect((await store.workingOn('greenhouse', ['a', 'b'])).map(i => i.id)).toEqual(['GRE-1'])
        expect(await store.engaged('greenhouse', ['a', 'b'])).toBe(true)
        replies['/api/projects/greenhouse/signals?waiting=pooled'] = [{id: 7, kind: 'message'}]
        expect(await store.pooledWaiting('greenhouse')).toEqual([{id: 7, kind: 'message'}])
    })
})
