import {describe, expect, it} from 'vitest'
import {seed} from '../server/utils/seed'
import {Store} from '../server/utils/store'
import {testDb} from './db'

describe('the demo seed', () => {
    it('fills an empty Orrery once, and leaves one with projects alone', async () => {
        const db = testDb()
        expect(await seed(db)).toBe(true)
        const store = new Store(db)
        expect((await store.listProjects()).map(p => p.id)).toEqual(['admin', 'larder', 'repository', 'storefront'])
        expect((await store.ownerOf()).name).toBe('demo')
        // The monorepo's shared release counts its apps' issues.
        expect((await store.release('repository', '2.25.0')).projects.map(p => p.project)).toEqual(['repository', 'admin', 'storefront'])
        expect((await store.listIssues('storefront', {proposal: 'pending'})).length).toBe(2)
        expect(await seed(db)).toBe(false)
        expect((await store.listProjects()).length).toBe(4)
    })
})
