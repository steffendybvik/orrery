import {beforeEach, describe, expect, it, vi} from 'vitest'
import {Pulls} from '../server/utils/pulls'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// An issue's PRs are read off its project's repo, which the Rust API keeps when it's in front (ORR-1143): the table
// here is read only with no API set up.
const asked: string[] = []
let project: {repo?: string} | Error | undefined
vi.mock('../server/utils/api-router', () => ({
    readFromApi: async (path: string) => {
        // Only the project's own read: what's kept of the issue's PRs is the table's here.
        if (!path.startsWith('/api/projects/') || path.includes('/kept-pulls')) return undefined
        asked.push(path)
        if (project instanceof Error) throw project
        return project
    },
    writeToApi: async () => undefined,
}))

let store: Store
let pulls: Pulls

beforeEach(async () => {
    asked.length = 0
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO', repo: 'https://github.com/here/table'})
    await store.createIssue('shop', {title: 'Pay'}, {name: 'skoll', owner: true})
    pulls = new Pulls(store, async () => new Response('[]', {status: 200}), () => 0)
})

describe("an issue's PRs, its project's repo read from the API (ORR-1143)", () => {
    it("reads the repo there, and the table here only with no API", async () => {
        project = {repo: 'https://github.com/from/api'}
        expect((await pulls.forIssue('shop', 'SHO-1')).repo).toBe('from/api')
        expect(asked).toContain('/api/projects/shop?notes=0&closed=0')
        project = {}
        expect((await pulls.forIssue('shop', 'SHO-1')).repo).toBeNull()
        project = undefined
        expect((await pulls.forIssue('shop', 'SHO-1')).repo).toBe('here/table')
    })

    it("takes a project the API doesn't have as having no repo, and passes any other failure on", async () => {
        project = Object.assign(new Error('No project shop'), {statusCode: 404})
        expect((await pulls.forIssue('shop', 'SHO-1')).repo).toBeNull()
        project = Object.assign(new Error("The Rust API can't be reached"), {statusCode: 503})
        await expect(pulls.forIssue('shop', 'SHO-1')).rejects.toMatchObject({statusCode: 503})
    })
})
