import {beforeEach, describe, expect, it} from 'vitest'
import {fullId, keyFor, numberOf, shortId, shownId} from '#shared/roadmap'
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
        expect(fullId('milestone', 3, 'x7k2m9qd')).toBe('MLS-3-x7k2m9qd')
        expect(fullId('epic', 1, 'x7k2m9qd')).toBe('EPC-1-x7k2m9qd')
        expect(shortId('doc', 'doc-ideas-x7k2m9qd', 'x7k2m9qd')).toBe('ideas')
        expect(shortId('issue', 'ORR-660-aaaaaaaa', 'x7k2m9qd')).toBeNull()
        expect(shortId('issue', 'ORR-660', 'x7k2m9qd')).toBeNull()
    })

    it('show a milestone and an epic as an issue is shown, and read every form back (ORR-995)', () => {
        expect(shownId('milestone', 14)).toBe('MLS-14')
        expect(shownId('epic', '1')).toBe('EPC-1')
        for (const sent of ['14', 'MLS-14', 'mls-14', 'MLS-14-x7k2m9qd', 'mls-14-x7k2m9qd', 'chk-14-x7k2m9qd']) expect(numberOf('milestone', sent, 'x7k2m9qd')).toBe('14')
        for (const sent of [1, '1', 'EPC-1', 'epc-1', 'EPC-1-x7k2m9qd']) expect(numberOf('epic', sent, 'x7k2m9qd')).toBe('1')
        expect(numberOf('milestone', 'MLS-14-aaaaaaaa', 'x7k2m9qd')).toBeNull()
        expect(numberOf('epic', 'MLS-1', 'x7k2m9qd')).toBeNull()
        expect(numberOf('milestone', 'autumn', 'x7k2m9qd')).toBeNull()
    })

    it('keeps the keys they start with off projects (ORR-995)', async () => {
        expect(keyFor('Mlsx')).toBe('MLSX')
        expect(keyFor('Epc')).toBe('EPCP')
        expect(keyFor('Epcot')).toBe('EPCO')
        for (const key of ['MLS', 'EPC']) await expect(store.createProject({name: `board ${key}`, key}, me)).rejects.toMatchObject({statusCode: 400})
        expect((await store.createProject({name: 'Epcot'}, me)).key).toBe('EPCO')
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

    it('finds a milestone and a doc the same way', async () => {
        const milestone = await store.createMilestone('shop', {title: 'Autumn'}, me)
        const milestoneFull = fullId('milestone', milestone.id, await uid('shop'))
        expect(await store.milestone('shop', milestoneFull)).toMatchObject({id: milestone.id, full_id: milestoneFull})
        await expect(store.milestone('yard', milestoneFull)).rejects.toMatchObject({statusCode: 404})

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

    it('finds a milestone by its shown id and the lowercase full id of before (ORR-995)', async () => {
        const milestone = await store.createMilestone('shop', {title: 'Autumn'}, me)
        for (const sent of [`MLS-${milestone.id}`, `mls-${milestone.id}`, `mls-${milestone.id}-${await uid('shop')}`]) expect((await store.milestone('shop', sent)).id).toBe(milestone.id)
        const {id} = await store.createIssue('shop', {title: 'Till', milestone: `MLS-${milestone.id}`}, me)
        expect((await store.issue('shop', id)).milestone).toBe(milestone.id)
    })

    it('finds an epic by its number, its shown id and its full id, with the server\'s uid (ORR-995)', async () => {
        const epic = await store.createEpic({title: 'Checkout'}, me)
        const full = fullId('epic', epic.id, (await store.settings()).uid)
        expect(epic.full_id).toBe(full)
        const {id} = await store.createIssue('shop', {title: 'Till', epic: `EPC-${epic.id}`}, me)
        expect((await store.issue('shop', id)).epic).toBe(epic.id)
        await store.updateIssue('shop', id, {epic: null}, me)
        await store.updateIssue('shop', id, {epic: full}, me)
        expect((await store.issue('shop', id)).epic).toBe(epic.id)
        await store.updateIssue('shop', id, {epic: epic.id}, me)
        expect((await store.issue('shop', id)).epic).toBe(epic.id)
        await expect(store.updateIssue('shop', id, {epic: `EPC-${epic.id}-aaaaaaaa`}, me)).rejects.toMatchObject({statusCode: 404})
        await expect(store.updateIssue('shop', id, {epic: true}, me)).rejects.toMatchObject({statusCode: 400})
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
