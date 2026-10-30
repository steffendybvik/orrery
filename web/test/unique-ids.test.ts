import {beforeEach, describe, expect, it} from 'vitest'
import {fullId, shortId} from '#shared/roadmap'
import {copyDatabase} from '../server/utils/copy'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// A pasted id says which board it's from (ORR-674): its full form finds the thing on its own board and nothing on any
// other, and the short forms keep working.
const me = {name: 'skoll', owner: true}
let store: Store

beforeEach(async () => {
    store = new Store(testDb())
    await store.createProject({name: 'shop', key: 'SHO'}, me)
    await store.createProject({name: 'yard', key: 'SHO'}, me)
})
const uid = async (project: string) => (await store.project(project)).uid

describe('full ids', () => {
    it('are made and read back by kind', () => {
        expect(fullId('issue', 'ORR-660', 'x7k2m9qd')).toBe('ORR-660-x7k2m9qd')
        expect(fullId('doc', 'ideas', 'x7k2m9qd')).toBe('doc-ideas-x7k2m9qd')
        expect(fullId('chunk', 3, 'x7k2m9qd')).toBe('chk-3-x7k2m9qd')
        expect(shortId('doc', 'doc-ideas-x7k2m9qd', 'x7k2m9qd')).toBe('ideas')
        expect(shortId('issue', 'ORR-660-aaaaaaaa', 'x7k2m9qd')).toBeNull()
        expect(shortId('issue', 'ORR-660', 'x7k2m9qd')).toBeNull()
    })

    it('gives each board and the server a random id', async () => {
        expect(await uid('shop')).toMatch(/^[a-z2-7]{8}$/)
        expect(await uid('shop')).not.toBe(await uid('yard'))
        expect((await store.settings()).uid).toMatch(/^[a-z2-7]{8}$/)
    })

    it('finds an issue on its own board, and nothing on another with the same key', async () => {
        const {id} = await store.createIssue('shop', {title: 'Till'}, me)
        await store.createIssue('yard', {title: 'Gate'}, me)
        const full = fullId('issue', id, await uid('shop'))
        const issue = await store.issue('shop', full)
        expect(issue).toMatchObject({id, title: 'Till', full_id: full})
        expect((await store.issue('shop', id)).id).toBe(id)
        await expect(store.issue('yard', full)).rejects.toMatchObject({statusCode: 404})
        await store.updateIssue('shop', full, {title: 'The till'}, me)
        expect((await store.issue('shop', id)).title).toBe('The till')
        await expect(store.updateIssue('yard', full, {title: 'Nope'}, me)).rejects.toMatchObject({statusCode: 404})
    })

    it('finds an alias by its full form', async () => {
        const {id} = await store.createIssue('shop', {title: 'Till'}, me)
        await store.db.run('INSERT INTO issue_aliases (project, alias, issue) VALUES (?, ?, ?)', 'shop', 'OLD-5', id)
        expect((await store.issue('shop', fullId('issue', 'OLD-5', await uid('shop')))).id).toBe(id)
    })

    it('finds a chunk and a doc the same way', async () => {
        const chunk = await store.createChunk('shop', {title: 'Autumn'}, me)
        const chunkFull = fullId('chunk', chunk.id, await uid('shop'))
        expect(await store.chunk('shop', chunkFull)).toMatchObject({id: chunk.id, full_id: chunkFull})
        await expect(store.chunk('yard', chunkFull)).rejects.toMatchObject({statusCode: 404})

        await store.createDoc('shop', {title: 'Ideas', body: 'Words.'}, me)
        const docFull = fullId('doc', 'ideas', await uid('shop'))
        expect(await store.doc('shop', docFull)).toMatchObject({id: 'ideas', full_id: docFull})
        expect((await store.doc('shop', 'ideas')).id).toBe('ideas')
        await expect(store.doc('yard', docFull)).rejects.toMatchObject({statusCode: 404})
        await store.updateDoc('shop', docFull, {body: 'More.'}, me)
        expect((await store.doc('shop', 'ideas')).body).toBe('More.')
        // Another board's full id doesn't make a doc by that name.
        await expect(store.putDoc('yard', docFull, {title: 'Ideas', body: 'Mine.'}, me)).rejects.toMatchObject({statusCode: 404})
    })

    it('stops resolving when an issue moves to another board', async () => {
        const {id} = await store.createIssue('shop', {title: 'Till'}, me)
        const full = fullId('issue', id, await uid('shop'))
        await store.updateIssue('shop', id, {project: 'yard'}, me)
        await expect(store.issue('shop', full)).rejects.toMatchObject({statusCode: 404})
        await expect(store.issue('yard', full)).rejects.toMatchObject({statusCode: 404})
    })

    it('goes with the board in a copy of the database', async () => {
        const target = testDb()
        await copyDatabase(store.db, target)
        const copy = new Store(target)
        expect((await copy.project('shop')).uid).toBe(await uid('shop'))
        expect((await copy.settings()).uid).toBe((await store.settings()).uid)
    })

    it('refuses a new key that reads as a full id, and keeps one in use', async () => {
        await expect(store.createProject({name: 'docs', key: 'DOC'}, me)).rejects.toMatchObject({statusCode: 400})
    })
})
