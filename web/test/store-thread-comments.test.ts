// Comments on a milestone and on an epic (ORR-977): words on its page, by an issue comment's rules for who may change
// them, which go with what they're on.
import {beforeEach, describe, expect, it} from 'vitest'
import type {Actor} from '../server/utils/store'
import {Store} from '../server/utils/store'
import {testDb} from './db'
import {failure} from './store-setup'

let store: Store
let changes: string[]
let epicsTold: number
const owner: Actor = {name: 'skoll', owner: true}
const agent: Actor = {name: 'claude', owner: false, session: 'orrery · Ty'}

beforeEach(async () => {
    changes = []
    epicsTold = 0
    store = new Store(testDb(), project => changes.push(project))
    store.epicsChanged = () => epicsTold++
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.createMilestone('greenhouse', {title: 'Moving parts: joints'})
})

describe('comments on a milestone', () => {
    it('are kept, listed oldest first, and tell the project', async () => {
        changes.length = 0
        const first = await store.createMilestoneComment('greenhouse', '1', {body: 'Hinges first.'}, agent)
        expect(first).toMatchObject({project: 'greenhouse', milestone: '1', body: 'Hinges first.', created_by: 'claude', session_name: 'orrery · Ty', protected: false})
        expect(changes).toContain('greenhouse')
        await store.createMilestoneComment('greenhouse', '1', {body: 'Then the latches.'}, owner)
        expect((await store.listMilestoneComments('greenhouse', '1')).map(c => [c.body, c.protected])).toEqual([['Hinges first.', false], ['Then the latches.', true]])
        // Its full id works too, as for the milestone itself.
        const {full_id} = await store.milestone('greenhouse', '1')
        expect(await store.listMilestoneComments('greenhouse', full_id)).toHaveLength(2)
    })

    it('refuse a body that isn\'t words, and a milestone or comment that isn\'t there', async () => {
        expect(await failure(() => store.createMilestoneComment('greenhouse', '1', {body: ' '}))).toMatchObject({status: 400, message: '"body" can\'t be empty'})
        expect(await failure(() => store.createMilestoneComment('greenhouse', '1', {body: 'x', asks: 'decision'}))).toMatchObject({status: 400})
        expect(await failure(() => store.createMilestoneComment('greenhouse', '9', {body: 'x'}))).toMatchObject({status: 404})
        expect(await failure(() => store.updateMilestoneComment('greenhouse', '1', 999, {body: 'x'}))).toMatchObject({status: 404, message: 'No comment 999 on milestone 1'})
    })

    it('leave the owner\'s words to the owner, and an agent\'s to anyone', async () => {
        const theirs = await store.createMilestoneComment('greenhouse', '1', {body: 'Brass.'}, owner)
        expect(await failure(() => store.updateMilestoneComment('greenhouse', '1', theirs.id, {body: 'Tin.'}, agent))).toMatchObject({status: 403})
        expect(await failure(() => store.deleteMilestoneComment('greenhouse', '1', theirs.id, agent))).toMatchObject({status: 403})
        expect(await store.updateMilestoneComment('greenhouse', '1', theirs.id, {body: 'Polished brass.'}, owner)).toMatchObject({body: 'Polished brass.'})
        const mine = await store.createMilestoneComment('greenhouse', '1', {body: 'Noted.'}, agent)
        await store.deleteMilestoneComment('greenhouse', '1', mine.id, agent)
        expect((await store.listMilestoneComments('greenhouse', '1')).map(c => c.body)).toEqual(['Polished brass.'])
    })

    it('go with their milestone, and with their project', async () => {
        await store.createMilestoneComment('greenhouse', '1', {body: 'Gone with it.'})
        await store.deleteMilestone('greenhouse', '1', owner)
        expect(await store.db.all('SELECT * FROM milestone_comments')).toEqual([])
        const {id} = await store.createMilestone('greenhouse', {title: 'Glazing'})
        await store.createMilestoneComment('greenhouse', id, {body: 'And with the project.'})
        await store.deleteProject('greenhouse', owner)
        expect(await store.db.all('SELECT * FROM milestone_comments')).toEqual([])
    })
})

describe('comments on an epic', () => {
    it('are kept, refused for an epic that isn\'t there, and tell the epics', async () => {
        const {id} = await store.createEpic({title: 'Weatherproofing'}, owner)
        epicsTold = 0
        const comment = await store.createEpicComment(id, {body: 'Across the greenhouse and the shed.'}, agent)
        expect(comment).toMatchObject({epic: id, body: 'Across the greenhouse and the shed.', protected: false})
        expect(epicsTold).toBe(1)
        expect(await store.listEpicComments(id)).toEqual([comment])
        expect(await failure(() => store.listEpicComments(id + 1))).toMatchObject({status: 404})
    })

    it('leave the owner\'s words to the owner, saying which row holds them, and go with the epic', async () => {
        const {id} = await store.createEpic({title: 'Weatherproofing'}, owner)
        const theirs = await store.createEpicComment(id, {body: 'Seal it.'}, owner)
        expect(await failure(() => store.deleteEpicComment(id, theirs.id, agent))).toMatchObject({status: 403})
        const refused = await store.updateEpicComment(id, theirs.id, {body: 'x'}, agent).then(() => null, (error: {statusCode: number, data: unknown}) => error)
        expect(refused).toMatchObject({statusCode: 403, data: {permission: 'epics.comment'}})
        // A comment on another epic isn't this one's.
        const other = await store.createEpic({title: 'Shelving'}, owner)
        expect(await failure(() => store.deleteEpicComment(other.id, theirs.id, owner))).toMatchObject({status: 404})
        await store.deleteEpic(id, owner)
        expect(await store.db.all('SELECT * FROM epic_comments')).toEqual([])
    })
})
