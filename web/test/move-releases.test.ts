import {beforeEach, describe, expect, it} from 'vitest'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// An issue moved to another project keeps its release only when both projects ship the same releases (ORR-500): one
// that draws on the other's, or both on a third. Anywhere else the release isn't there, so it's let go, sub-issues too.
const me = {name: 'skoll', owner: true}
let store: Store

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO', release_mode: 'own'}, me)
    await store.createRelease('shop', {version: '1.0'}, me)
    await store.createProject({name: 'app', key: 'APP', release_mode: 'shared', releases_from: 'shop'}, me)
    await store.createProject({name: 'docs', key: 'DOC', release_mode: 'own'}, me)
    await store.createRelease('docs', {version: '1.0'}, me)
    await store.createProject({name: 'lab', key: 'LAB'}, me)
    await store.createIssue('shop', {title: 'Refunds', release: '1.0'}, me)
    await store.createIssue('shop', {title: 'Receipts', parent: 'SHO-1', release: '1.0'}, me)
})

/** The release of the moved issue and its sub-issue, in the project they went to. */
async function releases(to: string) {
    const moved = await store.updateIssue('shop', 'SHO-1', {project: to}, me)
    const sub = moved.tasks.map(t => t.id)[0]
    return [moved.release ?? null, sub ? (await store.issue(to, sub)).release ?? null : 'no sub-issue']
}

describe('moving an issue to another project', () => {
    it('keeps its release in a project that ships the same releases', async () => {
        expect(await releases('app')).toEqual(['1.0', '1.0'])
    })

    it("lets it go in one with releases of its own, even one with the same version", async () => {
        expect(await releases('docs')).toEqual([null, null])
    })

    it('lets it go in one without releases', async () => {
        expect(await releases('lab')).toEqual([null, null])
    })
})
