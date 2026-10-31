import {beforeEach, describe, expect, it} from 'vitest'
import {Schedules} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
let store: Store
let schedules: Schedules

beforeEach(async () => {
    store = new Store(testDb(), () => {})
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.createProject({name: 'pantry', key: 'PAN'})
    schedules = new Schedules(store)
})

const tidy = {title: 'Tidy', kind: 'action', on: 'issue.labels', column: 'done'}
const onProjects = async () => (await schedules.list()).map(s => s.project).sort()

describe('a schedule across projects', () => {
    it('is made on every project, and takes in one added later', async () => {
        const made = await schedules.createAcross({projects: '*', ...tidy}, me)
        expect(made).toMatchObject({projects: '*', skip: [], on_projects: ['greenhouse', 'pantry'], title: 'Tidy'})
        expect(await onProjects()).toEqual(['greenhouse', 'pantry'])
        expect((await schedules.list())[0]).toMatchObject({across: made.id, protected: true, kind: 'action'})
        await store.createProject({name: 'cellar', key: 'CEL'})
        await schedules.settleAcross()
        expect(await onProjects()).toEqual(['cellar', 'greenhouse', 'pantry'])
    })

    it('runs for each project apart, and each run is its own project\'s', async () => {
        await schedules.createAcross({projects: '*', ...tidy}, me)
        const one = await store.createIssue('greenhouse', {title: 'A', status: 'todo'}, me)
        const two = await store.createIssue('pantry', {title: 'B', status: 'todo'}, me)
        await schedules.hear({type: 'issue.labels', project: 'greenhouse', subject: one.id})
        await schedules.hear({type: 'issue.labels', project: 'pantry', subject: two.id})
        expect((await store.issue('greenhouse', one.id)).column).toBe('done')
        expect((await store.issue('pantry', two.id)).column).toBe('done')
        const [g, p] = await Promise.all([schedules.list('greenhouse'), schedules.list('pantry')])
        expect(g[0]?.runs[0]).toMatchObject({outcome: 'made', issue: one.id})
        expect(p[0]?.runs[0]).toMatchObject({outcome: 'made', issue: two.id})
    })

    it('can be for a list, which a project gone drops out of', async () => {
        const made = await schedules.createAcross({projects: ['pantry'], ...tidy}, me)
        expect(made.on_projects).toEqual(['pantry'])
        await expect(schedules.createAcross({projects: ['nowhere'], ...tidy}, me)).rejects.toMatchObject({statusCode: 404})
        await store.deleteProject('pantry', me)
        await schedules.settleAcross()
        expect(await onProjects()).toEqual([])
    })

    it('leaves a copy paused on its own, or by Pause all, paused when the schedule across projects changes', async () => {
        const across = await schedules.createAcross({projects: '*', title: 'Tidy', cron: '0 9 * * *'}, me)
        await schedules.setAllEnabled('pantry', false, me)
        await schedules.updateAcross(across.id, {title: 'Tidy up'}, me)
        const copies = await schedules.list()
        expect(copies.find(s => s.project === 'pantry')).toMatchObject({title: 'Tidy up', enabled: false})
        expect(copies.find(s => s.project === 'greenhouse')).toMatchObject({title: 'Tidy up', enabled: true})
    })

    it('lets a project opt out by removing its copy, and stays out', async () => {
        const made = await schedules.createAcross({projects: '*', ...tidy}, me)
        const [copy] = await schedules.list('pantry')
        await schedules.delete('pantry', copy!.id, me)
        await schedules.settleAcross()
        expect(await onProjects()).toEqual(['greenhouse'])
        expect((await schedules.listAcross())[0]).toMatchObject({id: made.id, skip: ['pantry']})
        await schedules.updateAcross(made.id, {skip: []}, me)
        expect(await onProjects()).toEqual(['greenhouse', 'pantry'])
    })

    it('changes every copy, keeping what each has run, and copies can only be paused themselves', async () => {
        const made = await schedules.createAcross({projects: '*', title: 'Nudge', kind: 'message', notes: 'Hi', cron: '0 9 * * *'}, me)
        const [copy] = await schedules.list('pantry')
        await expect(schedules.update('pantry', copy!.id, {title: 'Mine'}, me)).rejects.toMatchObject({statusCode: 409})
        expect((await schedules.update('pantry', copy!.id, {enabled: false}, me)).enabled).toBe(false)
        await schedules.runNow('greenhouse', (await schedules.list('greenhouse'))[0]!.id, me)
        await schedules.updateAcross(made.id, {title: 'Morning nudge', on: 'issue.status'}, me)
        const [g] = await schedules.list('greenhouse')
        expect(g).toMatchObject({title: 'Morning nudge', on: 'issue.status', cron: undefined})
        expect(g?.runs).toHaveLength(1)
        // What a project added later is made from has the change too.
        await store.createProject({name: 'cellar', key: 'CEL'})
        await schedules.settleAcross()
        expect((await schedules.list('cellar'))[0]).toMatchObject({title: 'Morning nudge', on: 'issue.status', cron: undefined})
    })

    it('refuses a change one project can\'t take before changing any', async () => {
        const made = await schedules.createAcross({projects: '*', ...tidy}, me)
        await expect(schedules.updateAcross(made.id, {column: 'nowhere', title: 'Changed'}, me)).rejects.toMatchObject({statusCode: 400})
        expect((await schedules.list())[0]?.title).toBe('Tidy')
        expect((await schedules.listAcross())[0]?.title).toBe('Tidy')
    })

    it('deletes with its copies, whose issues stay', async () => {
        const made = await schedules.createAcross({projects: '*', title: 'Groom', cron: '0 9 * * *', timezone: 'UTC'}, me)
        const run = await schedules.runNow('greenhouse', (await schedules.list('greenhouse'))[0]!.id, me)
        await schedules.deleteAcross(made.id, me)
        expect(await onProjects()).toEqual([])
        expect(await schedules.listAcross()).toEqual([])
        expect((await store.issue('greenhouse', run.issue!)).title).toMatch(/^Groom/)
    })

    it('is the owner\'s, and can\'t say what\'s only one project\'s', async () => {
        const failure = async (body: object, actor = me) => await schedules.createAcross(body, actor).then(() => 0, (e: {statusCode: number}) => e.statusCode)
        expect(await failure({projects: '*', ...tidy}, agent)).toBe(403)
        expect(await failure(tidy)).toBe(400)
        expect(await failure({projects: [], ...tidy})).toBe(400)
        expect(await failure({projects: '*', ...tidy, chunk: '1'})).toBe(400)
        expect(await failure({projects: '*', title: 'x', at: '2099-01-01T00:00:00Z'})).toBe(400)
        expect(await failure({projects: '*', title: 'x', kind: 'message', notes: 'y', cron: '0 9 * * *', untrusted: true})).toBe(400)
        expect(await failure({projects: '*', skip: ['greenhouse', 'pantry'], ...tidy})).toBe(400)
        expect(await failure({projects: '*', title: 'x', cron: 'nope'})).toBe(400)
        expect(await onProjects()).toEqual([])
    })
})
