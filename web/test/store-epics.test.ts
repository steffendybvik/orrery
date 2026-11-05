// Epics (ORR-895): one piece of work across projects, holding issues from any of them. The store, against a fresh
// database with the project `greenhouse` (store-setup.ts) and a second one, `garden`.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store
let changes: string[]
const owner = {name: 'skoll', owner: true}

beforeEach(async () => {
    ({store, changes} = await storeSetup())
    await store.createProject({name: 'garden', key: 'GAR'})
})

describe('epics', () => {
    it('are numbered across the orrery, a new one on top, and arranged by hand', async () => {
        const first = await store.createEpic({title: 'Checkout tracking', notes: 'Attribution end to end.'})
        const second = await store.createEpic({title: 'Search'})
        expect(first).toMatchObject({id: 1, title: 'Checkout tracking', notes: 'Attribution end to end.', issues: 0, projects: [], parts: [], protected: false})
        expect((await store.epics()).map(e => e.id)).toEqual([second.id, first.id])
        await store.updateEpic(first.id, {position: 0})
        expect((await store.epics()).map(e => e.id)).toEqual([first.id, second.id])
        expect(await store.updateEpic(first.id, {title: 'Tracking', notes: null})).toMatchObject({title: 'Tracking'})
        expect((await store.epic(first.id)).notes).toBeUndefined()
        expect((await failure(() => store.createEpic({}))).status).toBe(400)
        expect((await failure(() => store.epic(9))).status).toBe(404)
    })

    it('hold issues from any project, counting their progress across all of them', async () => {
        const epic = await store.createEpic({title: 'Checkout tracking'})
        const front = await store.createIssue('greenhouse', {title: 'Track the checkout', epic: epic.id})
        const sub = await store.createIssue('greenhouse', {title: 'Send the event', parent: front.id, status: 'done'})
        await store.createIssue('greenhouse', {title: 'Its own sub-issue', parent: front.id})
        const api = await store.createIssue('garden', {title: 'Store the attribution'})
        await store.updateIssue('garden', api.id, {epic: epic.id})
        await store.createIssue('garden', {title: 'Not in it'})

        const read = await store.epic(epic.id)
        expect(read.issues).toBe(2)
        expect(read.kinds.done).toBe(1)
        expect(Object.values(read.kinds).reduce((a, b) => a + b, 0)).toBe(3)
        expect(read.projects.map(p => [p.project, p.issues])).toEqual([['garden', 1], ['greenhouse', 1]])
        expect(read.parts.map(p => [p.project, p.tasks.map(t => t.title)])).toEqual([['garden', ['Store the attribution']], ['greenhouse', ['Track the checkout']]])
        expect(read.parts[1]!.tasks[0]!.tasks.map(t => t.id)).toContain(sub.id)
        expect((await store.issue('garden', api.id)).epic).toBe(epic.id)
        expect((await store.listActivity('garden', api.id)).some(e => e.field === 'epic' && e.after === String(epic.id))).toBe(true)
    })

    it('keep an issue that moves to another project, as they span projects', async () => {
        const epic = await store.createEpic({title: 'Checkout tracking'})
        const issue = await store.createIssue('greenhouse', {title: 'Track the checkout', epic: epic.id})
        const moved = await store.updateIssue('greenhouse', issue.id, {project: 'garden'})
        expect(moved.epic).toBe(epic.id)
        expect((await store.epic(epic.id)).projects.map(p => p.project)).toEqual(['garden'])
    })

    it('are set and cleared many at once, and an issue leaves with null', async () => {
        const epic = await store.createEpic({title: 'Checkout tracking'})
        const a = await store.createIssue('greenhouse', {title: 'One'})
        const b = await store.createIssue('greenhouse', {title: 'Two'})
        await store.updateIssues('greenhouse', {ids: [a.id, b.id], set: {epic: epic.id}})
        expect((await store.epic(epic.id)).issues).toBe(2)
        await store.updateIssue('greenhouse', a.id, {epic: null})
        expect((await store.issue('greenhouse', a.id)).epic).toBeUndefined()
        expect((await failure(() => store.updateIssue('greenhouse', a.id, {epic: 42}))).status).toBe(404)
    })

    it('go without taking their issues, and only the owner deletes their own', async () => {
        const theirs = await store.createEpic({title: 'Attribution'}, owner)
        expect(theirs.protected).toBe(true)
        const epic = await store.createEpic({title: 'Checkout tracking'})
        const issue = await store.createIssue('greenhouse', {title: 'Track the checkout', epic: epic.id})
        changes.length = 0
        await store.deleteEpic(epic.id)
        expect((await store.issue('greenhouse', issue.id)).epic).toBeUndefined()
        expect(changes).toContain('greenhouse')
        expect((await failure(() => store.deleteEpic(theirs.id))).status).toBe(403)
        await store.deleteEpic(theirs.id, owner)
        expect(await store.epics()).toEqual([])
    })

    it('tell open pages when they change', async () => {
        let told = 0
        store.epicsChanged = () => told++
        const epic = await store.createEpic({title: 'Checkout tracking'})
        await store.updateEpic(epic.id, {title: 'Tracking'})
        await store.deleteEpic(epic.id)
        expect(told).toBe(3)
    })
})
