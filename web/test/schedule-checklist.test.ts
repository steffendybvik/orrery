import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {splitChecklist} from '../server/utils/schedule-checklist'
import {Schedules} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// An issue schedule's checklist as sub-issues (ORR-722): how the notes split, and what a run makes of them.
const me = {name: 'skoll', owner: true}
const NOTES = `Get it ready.

- [ ] **Feature freeze:** only fixes go in from here.
- [ ] **Update PR description.
- [ ] **Update the images.** On the playground, retake them.
- [ ] Run unit and e2e

Don't merge into main.`

describe('splitting the notes', () => {
    it('takes a bold lead as the title, the rest as notes, and leaves the rest to the parent', () => {
        expect(splitChecklist(NOTES)).toEqual({
            notes: 'Get it ready.\n\nDon\'t merge into main.',
            items: [
                {title: 'Feature freeze', notes: 'only fixes go in from here.'},
                {title: 'Update PR description'},
                {title: 'Update the images', notes: 'On the playground, retake them.'},
                {title: 'Run unit and e2e'},
            ],
        })
    })

    it('leaves notes with no checklist as they are', () => {
        expect(splitChecklist('Look at it.\n\n- a list\n- [x] done\n')).toEqual({notes: 'Look at it.\n\n- a list\n- [x] done', items: []})
    })

    it('keeps what\'s indented under a line with it, nested checkboxes too', () => {
        expect(splitChecklist('- [ ] **One:** first\n  more of it\n  - [ ] inside\n\nAfter')).toEqual({
            notes: 'After',
            items: [{title: 'One', notes: 'first\nmore of it\n- [ ] inside'}],
        })
    })

    it('leaves a line in a code block, and bold further along a title', () => {
        expect(splitChecklist('```\n- [ ] not one\n```\n- [ ] Check **this** now').items).toEqual([{title: 'Check **this** now'}])
        expect(splitChecklist('```\n- [ ] not one\n```').notes).toBe('```\n- [ ] not one\n```')
    })
})

describe('a run', () => {
    let store: Store
    let schedules: Schedules
    let signals: Signal[]
    const make = (body: Record<string, unknown> = {}) => schedules.create('greenhouse', {title: 'Pre-release', cron: '0 9 * * *', timezone: 'UTC', notes: NOTES, chunk: '1', priority: 'P2', column: 'todo', ...body}, me)
    const run = async (id: number) => (await schedules.runNow('greenhouse', id, me))

    beforeEach(async () => {
        signals = []
        store = new Store(testDb(), () => {}, signal => signals.push(signal))
        await store.createProject({name: 'greenhouse', key: 'GRE'})
        await store.createChunk('greenhouse', {title: 'Upkeep'})
        schedules = new Schedules(store)
    })

    it('makes a sub-issue for each line, in order, with the parent\'s priority, chunk and status', async () => {
        const made = await run((await make({labels: ['upkeep']})).id)
        expect(made).toMatchObject({outcome: 'made', note: 'with 4 sub-issues'})
        const parent = await store.issue('greenhouse', made.issue!)
        expect(parent).toMatchObject({notes: 'Get it ready.\n\nDon\'t merge into main.', chunk: '1', priority: 'P2', status: 'todo'})
        expect(parent.tasks.map(t => t.title)).toEqual(['Feature freeze', 'Update PR description', 'Update the images', 'Run unit and e2e'])
        const first = await store.issue('greenhouse', parent.tasks[0]!.id)
        expect(first).toMatchObject({notes: 'only fixes go in from here.', priority: 'P2', status: 'todo', parent: parent.id})
        expect(first.depends_on ?? []).toEqual([])
    })

    it('makes one issue when there\'s no checklist', async () => {
        const made = await run((await make({notes: 'Just look.'})).id)
        expect(made.note).toBeUndefined()
        expect(await store.issue('greenhouse', made.issue!)).toMatchObject({notes: 'Just look.', tasks: []})
    })

    it('asks about the parent only, a P0 too, and only once it\'s all made', async () => {
        const asked = await run((await make({ask: true})).id)
        expect(asked.note).toBe('with 4 sub-issues; asked the sessions (0 listening)')
        expect(signals.map(s => s.issue)).toEqual([asked.issue])
        signals.length = 0
        const urgent = await run((await make({priority: 'P0', title: 'Hot'})).id)
        expect(signals.map(s => s.issue)).toEqual([urgent.issue])
    })

    it('fails whole when a sub-issue can\'t be made, leaving none of it', async () => {
        const create = store.createIssue.bind(store)
        let calls = 0
        const spy = vi.spyOn(store, 'createIssue').mockImplementation((...args) => ++calls === 3 ? Promise.reject(new Error('No room')) : create(...args))
        const failed = await run((await make()).id)
        spy.mockRestore()
        expect(failed).toMatchObject({outcome: 'failed', note: 'No room'})
        expect(failed.issue).toBeUndefined()
        expect(await store.db.all('SELECT id FROM issues')).toEqual([])
    })

    it('skips the next run while any sub-issue is open, and not once they\'re done', async () => {
        const s = await make({notes: '- [ ] One\n- [ ] Two', cron: '0 9 * * *'})
        const made = await run(s.id)
        const [one, two] = (await store.issue('greenhouse', made.issue!)).tasks
        const due = async () => {
            const before = (await schedules.get('greenhouse', s.id)).runs.length
            await schedules.runDue(new Date(new Date((await schedules.get('greenhouse', s.id)).next_run!).getTime() + 60_000))
            return (await schedules.get('greenhouse', s.id)).runs.slice(0, (await schedules.get('greenhouse', s.id)).runs.length - before)[0]!
        }
        await store.updateIssue('greenhouse', one!.id, {status: 'done'}, me)
        await store.updateIssue('greenhouse', made.issue!, {status: 'done'}, me)
        expect(await due()).toMatchObject({outcome: 'skipped', note: `${made.issue} from the last run isn't done yet`})
        await store.updateIssue('greenhouse', two!.id, {status: 'done'}, me)
        expect((await due()).outcome).toBe('made')
    })
})
