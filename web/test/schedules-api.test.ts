import {beforeEach, describe, expect, it, vi} from 'vitest'
import {Schedules} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// The schedules' reads ask the Rust API when it's set up (ORR-1174), as the routes here once answered them: each open
// page hears a project's schedules again when they change. With no API they're read here.
let replies: Record<string, unknown> = {}
vi.mock('../server/utils/api-router', () => ({
    readFromApi: async (path: string) => replies[path],
    writeToApi: async () => undefined,
}))

let store: Store
let schedules: Schedules

beforeEach(async () => {
    replies = {}
    store = new Store(testDb())
    schedules = new Schedules(store)
    await store.createProject({name: 'Greenhouse', key: 'GRE'})
})

describe("the schedules' reads through the Rust API (ORR-1174)", () => {
    it("reads a project's, every project's and one schedule from the API", async () => {
        replies['/api/projects/greenhouse/schedules'] = [{id: 1, title: 'Morning'}]
        replies['/api/schedules'] = [{id: 1, title: 'Morning'}, {id: 2, title: 'Evening'}]
        replies['/api/projects/greenhouse/schedules/1'] = {id: 1, title: 'Morning', runs: []}
        expect(await schedules.list('greenhouse')).toEqual(replies['/api/projects/greenhouse/schedules'])
        expect(await schedules.list()).toEqual(replies['/api/schedules'])
        expect(await schedules.get('greenhouse', 1)).toEqual(replies['/api/projects/greenhouse/schedules/1'])
    })

    it('reads them here with no API', async () => {
        const made = await schedules.create('greenhouse', {title: 'Morning check', kind: 'message', notes: 'Look.', cron: '0 9 * * *'}, {name: 'ada', owner: true})
        expect((await schedules.list('greenhouse')).map(s => s.title)).toEqual(['Morning check'])
        expect((await schedules.get('greenhouse', made.id)).title).toBe('Morning check')
    })
})
