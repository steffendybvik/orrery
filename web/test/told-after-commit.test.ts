import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {OrreryEvent} from '#shared/happenings'
import type {Db} from '../server/utils/database'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// What a write sets off (the schedules, the event log) goes once its transaction has committed, and not at all when it
// rolls back (ORR-500): a change recorded inside a write that then fails mustn't run a schedule for what never happened.
let events: typeof import('../server/utils/events')
let db: Db
let heard: OrreryEvent[]

beforeEach(async () => {
    db = testDb()
    const store = new Store(db)
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.createIssue('greenhouse', {title: 'Hinges'})
    vi.stubGlobal('useDatabase', () => db)
    vi.stubGlobal('hearing', () => false)
    vi.resetModules()
    events = await import('../server/utils/events')
    heard = []
    events.projectEvents.on('happened', ({event}: {event: OrreryEvent}) => void heard.push(event))
})

afterEach(async () => {
    await new Promise(resolve => setImmediate(resolve))
    vi.unstubAllGlobals()
})

const settled = () => new Promise(resolve => setTimeout(resolve, 20))

describe("what a write sets off", () => {
    it('goes once the write has committed', async () => {
        await events.useStore().updateIssue('greenhouse', 'GRE-1', {status: 'done'})
        await settled()
        expect(heard.map(e => [e.type, e.subject, e.to])).toEqual([['issue.status', 'GRE-1', 'done']])
    })

    it("doesn't go when the write rolls back after recording the change", async () => {
        const store = events.useStore()
        // The change is recorded, and told, inside the transaction; then the write fails.
        await expect(db.transaction(async () => {
            await store.updateIssue('greenhouse', 'GRE-1', {status: 'done'})
            throw new Error('the write fails after it')
        })).rejects.toThrow('the write fails after it')
        await settled()
        expect(heard).toEqual([])
        expect((await store.issue('greenhouse', 'GRE-1')).column).not.toBe('done')
    })
})
