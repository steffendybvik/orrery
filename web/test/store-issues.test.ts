// Issues: made, edited, moved, removed, started one session at a time, done many at once, and what's urgent. The store,
// against a fresh database with the project `greenhouse` (store-setup.ts).
import {beforeEach, describe, expect, it} from 'vitest'
import {total} from '#shared/roadmap'
import {Store} from '../server/utils/store'
import {testDb} from './db'
import type {Actor} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store
let changes: string[]

beforeEach(async () => {
    ({store, changes} = await storeSetup())
})

describe('issues', () => {
    const add = async (body: Record<string, unknown>, actor?: Actor) => (await store.createIssue('greenhouse', body, actor)).id

    it('get distinct numbers when made at the same time', async () => {
        const made = await Promise.all(Array.from({length: 8}, (_, i) => store.createIssue('greenhouse', {title: `At once ${i}`})))
        expect(new Set(made.map(i => i.id)).size).toBe(8)
        expect((await store.createIssue('greenhouse', {title: 'After'})).id).toBe('GRE-9')
    })

    it('get the project prefix and the next number, and land in a column', async () => {
        const a = await store.createIssue('greenhouse', {title: 'Joint editor', chunk: '1', status: 'todo', priority: 'P1'})
        const b = await store.createIssue('greenhouse', {title: 'Unplanned'})
        expect([a.id, a.column, a.chunk]).toEqual(['GRE-1', 'todo', '1'])
        expect([b.id, b.column, b.chunk]).toEqual(['GRE-2', 'backlog', null])
        expect((await store.project('greenhouse')).board.chunks.map(c => c.title)).toEqual(['Moving parts: joints', 'No chunk'])
        expect(changes.at(-1)).toBe('greenhouse')
    })

    it("can't be given an id", async () => {
        expect((await failure(() => store.createIssue('greenhouse', {id: 'MOT-5', title: 'x'}))).message).toMatch(/^unknown field "id"/)
        expect((await failure(() => store.createChunk('greenhouse', {id: 'joints', title: 'x'}))).message).toMatch(/^unknown field "id"/)
    })

    it('nest in their parent and its chunk', async () => {
        const parent = await add({title: 'Joints', chunk: '1', status: 'todo'})
        const hinge = await add({title: 'Hinge', parent, status: 'in-progress'})
        const slider = await add({title: 'Slider', parent, status: 'done'})

        const shown = await store.issue('greenhouse', parent)
        expect(shown.column).toBe('in-progress')
        expect(shown.tasks.map(t => t.id)).toEqual([hinge, slider])
        expect([shown.kinds.done, total(shown.kinds)]).toEqual([1, 2])
        expect(await store.issue('greenhouse', hinge)).toMatchObject({parent, chunk: '1'})
        expect((await store.listIssues('greenhouse', {parent: 'none'})).map(i => i.id)).toEqual([parent])
        expect((await failure(() => add({title: 'x', parent, chunk: '1'}))).status).toBe(400)
    })

    it("can't become their own ancestor", async () => {
        const a = await add({title: 'A'})
        const b = await add({title: 'B', parent: a})
        expect((await failure(() => store.updateIssue('greenhouse', a, {parent: b}))).message).toBe(`${b} is under this issue, so it can't be its parent`)
        expect((await failure(() => store.updateIssue('greenhouse', a, {parent: a}))).status).toBe(400)
    })

    it('lift into the chunk they were in', async () => {
        const a = await add({title: 'A', chunk: '1'})
        const b = await add({title: 'B', parent: a})
        expect(await store.updateIssue('greenhouse', b, {parent: null})).toMatchObject({parent: null, chunk: '1'})
    })

    it('clear fields with null and go with their parent', async () => {
        const a = await add({title: 'A', priority: 'P1'})
        await add({title: 'B', parent: a})
        expect((await store.updateIssue('greenhouse', a, {priority: null})).priority).toBeUndefined()
        await store.deleteIssue('greenhouse', a)
        expect(await store.listIssues('greenhouse')).toEqual([])
    })

    it('keep an assignee and labels, and filter by them', async () => {
        const a = await add({title: 'A', assignee: 'claude', labels: ['bug', 'ui', 'bug']})
        const b = await add({title: 'B'})
        expect(await store.issue('greenhouse', a)).toMatchObject({assignee: 'claude', labels: ['bug', 'ui']})
        expect((await store.listIssues('greenhouse', {label: 'ui'})).map(i => i.id)).toEqual([a])
        expect((await store.listIssues('greenhouse', {assignee: 'none'})).map(i => i.id)).toEqual([b])
        expect(await store.updateIssue('greenhouse', a, {labels: null, assignee: null})).toMatchObject({labels: [], assignee: undefined})
        expect((await failure(() => add({title: 'x', labels: 'bug'}))).status).toBe(400)
    })

    it("move to another project with their sub-issues and comments, taking that project's ids", async () => {
        await store.createProject({name: 'orrery', key: 'ORR'})
        await store.createChunk('orrery', {title: 'v1'})
        await store.createIssue('orrery', {title: 'already there'})
        const a = await add({title: 'A', chunk: '1'})
        const b = await add({title: 'B', parent: a})
        await store.createComment('greenhouse', b, {body: 'hi'})

        const moved = await store.updateIssue('greenhouse', a, {project: 'orrery', chunk: '1', priority: 'P2'})
        expect(moved).toMatchObject({id: 'ORR-2', project: 'orrery', chunk: '1', parent: null, priority: 'P2', aliases: ['GRE-1']})
        expect(moved.tasks.map(t => t.id)).toEqual(['ORR-3'])
        expect((await store.listComments('orrery', b)).map(c => c.body)).toEqual(['hi'])
        expect((await store.issue('orrery', 'GRE-1')).id).toBe('ORR-2')
        expect(await store.listIssues('greenhouse')).toEqual([])
        expect(changes.slice(-3)).toEqual(['greenhouse', 'orrery', 'orrery'])
    })

    it('take their signals along when they move, so catching up finds them where they are', async () => {
        const owner = {name: 'skoll', owner: true}
        await store.createProject({name: 'orrery', key: 'ORR'})
        const a = await add({title: 'A'})
        await store.focus('greenhouse', a, {}, owner)
        const moved = await store.updateIssue('greenhouse', a, {project: 'orrery'})
        expect(await store.listSignals('greenhouse')).toEqual([])
        expect((await store.listSignals('orrery')).map(s => [s.project, s.issue])).toEqual([['orrery', moved.id]])
    })

    it("never take a number that's still an id something had", async () => {
        await store.createProject({name: 'orrery', key: 'ORR'})
        const a = (await store.createIssue('orrery', {title: 'A'})).id
        // Greenhouse's GRE-1 moves in as ORR-2 and keeps GRE-1 as an alias; ORR-3 is next either way, so make
        // an alias that's ahead of the counter, the way an import can.
        await store.updateIssue('greenhouse', await add({title: 'B'}), {project: 'orrery'})
        await store.db.run("INSERT INTO issue_aliases (project, alias, issue) VALUES ('orrery', 'ORR-3', ?)", a)
        expect((await store.createIssue('orrery', {title: 'C'})).id).toBe('ORR-4')
        expect((await store.issue('orrery', 'ORR-3')).id).toBe(a)
    })

    it('are found under a parent by an id it had', async () => {
        await store.createProject({name: 'orrery', key: 'ORR'})
        const a = await add({title: 'A'})
        await add({title: 'B', parent: a})
        const moved = await store.updateIssue('greenhouse', a, {project: 'orrery'})
        expect((await store.listIssues('orrery', {parent: a})).map(i => i.title)).toEqual(['B'])
        expect((await store.listIssues('orrery', {parent: moved.id})).map(i => i.title)).toEqual(['B'])
    })

    it('stay when their chunk is deleted', async () => {
        const a = await add({title: 'A', chunk: '1'})
        await store.deleteChunk('greenhouse', '1')
        expect((await store.issue('greenhouse', a)).chunk).toBeNull()
    })
})
describe('activity', () => {
    const owner: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}
    const changed = async (issue: string, project = 'greenhouse') => (await store.listActivity(project, issue)).map(e => [e.field, e.before, e.after, e.created_by])

    it('notes who changed which field, from what to what', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A', notes: 'first'}, owner)
        await store.updateIssue('greenhouse', id, {title: 'A', status: 'in-progress', assignee: 'claude', priority: 'P2'}, claude)
        await store.updateIssue('greenhouse', id, {notes: 'second', labels: ['ui'], chunk: '1'}, claude)
        await store.updateIssue('greenhouse', id, {notes: 'second', priority: null}, owner)
        expect(await changed(id)).toEqual([
            ['created', undefined, undefined, 'skoll'],
            ['status', 'backlog', 'in-progress', 'claude'],
            ['priority', undefined, 'P2', 'claude'],
            ['assignee', undefined, 'claude', 'claude'],
            ['labels', '[]', '["ui"]', 'claude'],
            ['notes', undefined, undefined, 'claude'],
            ['chunk', undefined, '1', 'claude'],
            ['priority', 'P2', undefined, 'skoll'],
        ])
        expect((await store.listActivity('greenhouse', id))[0]).toMatchObject({issue: id, protected: true})
    })

    it("keeps the name of the session that wrote it, as it was then (ORR-466)", async () => {
        const froya: Actor = {name: 'claude', owner: false, session: 'orrery · Frøya'}
        const {id} = await store.createIssue('greenhouse', {title: 'A'}, froya)
        await store.updateIssue('greenhouse', id, {status: 'in-progress'}, froya)
        await store.createComment('greenhouse', id, {body: 'On it'}, froya)
        await store.createComment('greenhouse', id, {body: 'By the API'}, claude)
        expect((await store.issue('greenhouse', id)).session_name).toBe('orrery · Frøya')
        expect((await store.listActivity('greenhouse', id)).map(e => e.session_name)).toEqual(['orrery · Frøya', 'orrery · Frøya'])
        expect((await store.listComments('greenhouse', id)).map(c => c.session_name)).toEqual(['orrery · Frøya', undefined])
    })

    it('notes a new parent, not the chunk that comes with it', async () => {
        const parent = (await store.createIssue('greenhouse', {title: 'P', chunk: '1'})).id
        const {id} = await store.createIssue('greenhouse', {title: 'A', chunk: '1'})
        await store.updateIssue('greenhouse', id, {parent})
        await store.updateIssue('greenhouse', id, {parent: null})
        expect((await changed(id)).slice(1)).toEqual([['parent', undefined, parent, 'agent'], ['parent', parent, undefined, 'agent']])
    })

    it('notes decisions and the assignee an ask hands over', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Button', proposal: 'pending'}, claude)
        await store.decide('greenhouse', id, {decision: 'approved'}, owner)
        await store.createComment('greenhouse', id, {body: 'Ship it?', asks: 'decision'}, claude)
        expect((await changed(id)).slice(1)).toEqual([
            ['proposal', 'pending', 'approved', 'skoll'],
            ['assignee', 'owner', 'claude', 'skoll'],
            // Approving puts it on the roadmap, in Todo.
            ['status', 'backlog', 'todo', 'skoll'],
            ['proposal', 'approved', undefined, 'skoll'],
            ['assignee', 'claude', 'owner', 'claude'],
        ])
    })

    it('moves with the issue to another project, and goes when it does', async () => {
        await store.createProject({name: 'orrery', key: 'ORR'})
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        const moved = await store.updateIssue('greenhouse', id, {project: 'orrery'}, owner)
        expect(await changed(moved.id, 'orrery')).toEqual([['created', undefined, undefined, 'agent'], ['project', 'greenhouse', 'orrery', 'skoll']])
        await store.deleteIssue('orrery', moved.id, owner)
        expect(await store.db.get('SELECT count(*) AS n FROM issue_events')).toEqual({n: 0})
    })
})
describe('an urgent issue', () => {
    const owner = {name: 'skoll', owner: true}

    it("goes to the sessions when the owner makes it P0: to its worker while it can hear, else to every one", async () => {
        const sent: string[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(`${signal.kind}:${signal.issue}:${signal.target ?? 'all'}:${signal.note}`))
        let listening = ['window-a']
        local.hears = (_project, session) => listening.includes(session)
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const fire = (await local.createIssue('greenhouse', {title: 'Fire', priority: 'P0'}, owner)).id
        const leak = (await local.createIssue('greenhouse', {title: 'Leak', priority: 'P2'}, owner)).id
        await local.workedBy('greenhouse', leak, 'window-a')
        await local.updateIssue('greenhouse', leak, {priority: 'P0'}, owner)
        // Already urgent, or not by the owner, or not work (a proposal, a closed issue): nothing goes.
        await local.updateIssue('greenhouse', leak, {priority: 'P0', title: 'Big leak'}, owner)
        await local.createIssue('greenhouse', {title: "An agent's", priority: 'P0'})
        await local.createIssue('greenhouse', {title: 'An idea', priority: 'P0', proposal: 'pending'}, owner)
        await local.createIssue('greenhouse', {title: 'Gone', priority: 'P0', status: 'done'}, owner)
        listening = []
        await local.updateIssue('greenhouse', leak, {priority: 'P1'}, owner)
        await local.updateIssue('greenhouse', leak, {priority: 'P0'}, owner)
        const note = 'It was just made urgent (P0).'
        expect(sent).toEqual([`focus:${fire}:all:${note}`, `focus:${leak}:window-a:${note}`, `focus:${leak}:all:${note}`])
    })

    it('goes when a P0 issue becomes open work: a proposal committed, a closed one reopened', async () => {
        const sent: string[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(String(signal.issue)))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const idea = (await local.createIssue('greenhouse', {title: 'An idea', priority: 'P0', proposal: 'pending'}, owner)).id
        const gone = (await local.createIssue('greenhouse', {title: 'Gone', priority: 'P0', status: 'done'}, owner)).id
        await local.updateIssue('greenhouse', idea, {proposal: null}, owner)
        await local.updateIssue('greenhouse', gone, {status: 'todo'}, owner)
        // Judged on its own status: a parent closed with a child still open isn't work any more.
        const parent = (await local.createIssue('greenhouse', {title: 'Parent', priority: 'P2'}, owner)).id
        await local.createIssue('greenhouse', {title: 'Child', parent}, owner)
        await local.updateIssue('greenhouse', parent, {priority: 'P0', status: 'done'}, owner)
        // An agent's raise, and a caller that asks the sessions itself, send nothing.
        await local.updateIssue('greenhouse', (await local.createIssue('greenhouse', {title: 'Theirs', priority: 'P2'})).id, {priority: 'P0'})
        await local.createIssue('greenhouse', {title: 'Scheduled', priority: 'P0'}, owner, {urgent: false})
        expect(sent).toEqual([idea, gone])
    })

    it("doesn't fail the saved write when the push fails", async () => {
        const local = new Store(testDb(), () => {}, () => {})
        local.hears = () => { throw new Error('no line') }
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const leak = (await local.createIssue('greenhouse', {title: 'Leak', priority: 'P2'}, owner)).id
        await local.workedBy('greenhouse', leak, 'window-a')
        await local.updateIssue('greenhouse', leak, {priority: 'P0'}, owner)
        expect((await local.issue('greenhouse', leak)).priority).toBe('P0')
    })
})
describe('many issues at once', () => {
    const owner = {name: 'skoll', owner: true}

    it('take one change each on its own, labels added and taken off, saying which were refused', async () => {
        const a = await store.createIssue('greenhouse', {title: 'A', labels: ['ui', 'old']})
        const b = await store.createIssue('greenhouse', {title: 'B'})
        changes.length = 0
        expect(await store.updateIssues('greenhouse', {ids: [a.id, b.id, 'GRE-99'], set: {priority: 'P1', assignee: 'claude'}, labels: {add: ['bulk'], remove: ['old']}}, owner))
            .toEqual([{id: a.id, ok: true}, {id: b.id, ok: true}, {id: 'GRE-99', ok: false, error: 'No issue GRE-99 in greenhouse'}])
        expect((await store.issue('greenhouse', a.id))).toMatchObject({priority: 'P1', assignee: 'claude', labels: ['ui', 'bulk']})
        expect((await store.issue('greenhouse', b.id)).labels).toEqual(['bulk'])
        // The page hears the batch once.
        expect(changes.filter(p => p === 'greenhouse')).toHaveLength(1)
        expect((await failure(() => store.updateIssues('greenhouse', {ids: [a.id], set: {title: 'x'}}, owner))).status).toBe(400)
        expect((await failure(() => store.updateIssues('greenhouse', {ids: []}, owner))).status).toBe(400)
    })

    it("are decided by the owner, skipping a proposal whose choices have no recommendation", async () => {
        const plain = await store.createIssue('greenhouse', {title: 'Plain', proposal: 'pending'})
        const unsure = await store.createIssue('greenhouse', {title: 'Unsure', proposal: 'pending', choices: [{key: 'k', question: 'Which?', options: [{key: 'a', title: 'A'}, {key: 'b', title: 'B'}]}]})
        const sure = await store.createIssue('greenhouse', {title: 'Sure', proposal: 'pending', choices: [{key: 'k', question: 'Which?', options: [{key: 'a', title: 'A'}, {key: 'b', title: 'B'}], recommended: ['a']}]})
        const results = await store.decideIssues('greenhouse', {ids: [plain.id, unsure.id, sure.id], decision: 'approved', note: 'All good'}, owner)
        expect(results.map(r => r.ok)).toEqual([true, false, true])
        expect(results[1]!.error).toBe('Needs your picks: nothing is recommended for "Which?"')
        expect((await store.issue('greenhouse', sure.id)).picks).toEqual({k: ['a']})
        expect((await store.issue('greenhouse', unsure.id)).proposal).toBe('pending')
        expect((await store.decideIssues('greenhouse', {ids: [unsure.id], decision: 'rejected'}, owner))[0]!.ok).toBe(true)
        expect((await store.decideIssues('greenhouse', {ids: [plain.id], decision: 'changes'}, {name: 'claude', owner: false}))[0]!.ok).toBe(false)
    })

    it('are deleted with their sub-issues, one under another in the list going with it', async () => {
        const parent = await store.createIssue('greenhouse', {title: 'Parent'})
        const sub = await store.createIssue('greenhouse', {title: 'Sub', parent: parent.id})
        const mine = await store.createIssue('greenhouse', {title: 'Mine'}, owner)
        expect(await store.deleteIssues('greenhouse', {ids: [parent.id, sub.id, mine.id]}, {name: 'claude', owner: false}))
            .toMatchObject([{id: parent.id, ok: true}, {id: sub.id, ok: true}, {id: mine.id, ok: false}])
        expect((await store.listIssues('greenhouse')).map(i => i.id)).toEqual([mine.id])
    })
})
describe('removing', () => {
    it('an issue takes its signals with it', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        await store.focus('greenhouse', id, {}, {name: 'skoll', owner: true})
        await store.deleteIssue('greenhouse', id, {name: 'skoll', owner: true})
        expect(await store.listSignals('greenhouse')).toEqual([])
        expect(await store.lastSignal('greenhouse')).toBe(0)
    })
})
describe('starting an issue', () => {
    it("is refused while another session that's there has it started", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        await store.claim('greenhouse', shelves, 'started', 'first')
        await store.updateIssue('greenhouse', shelves, {status: 'started'})
        await store.workedBy('greenhouse', shelves, 'first')
        const refused = await failure(() => store.claim('greenhouse', shelves, 'in-progress', 'second'))
        expect(refused).toEqual({status: 409, message: `${shelves} is already being worked on by another session (first); pick another issue`})
        // In review is still its work. Its own session starts it again, and any session closes it.
        expect((await failure(() => store.claim('greenhouse', shelves, 'in-review', 'second'))).status).toBe(409)
        await store.claim('greenhouse', shelves, 'started', 'first')
        await store.claim('greenhouse', shelves, 'done', 'second')
        expect(await store.takenFrom('greenhouse', shelves, 'second')).toBe('first')
        expect(await store.takenFrom('greenhouse', shelves, 'first')).toBeNull()
    })

    it("refuses another session's comment or edit too, not only starting it (ORR-287)", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-review'})).id
        await store.workedBy('greenhouse', shelves, 'first')
        // A write without a status (a comment, an edit), or one moving it back, is the work too.
        expect((await failure(() => store.claim('greenhouse', shelves, undefined, 'second'))).status).toBe(409)
        expect((await failure(() => store.claim('greenhouse', shelves, 'todo', 'second'))).status).toBe(409)
        expect((await failure(() => store.claimed('greenhouse', shelves, undefined, 'second', async () => 'written'))).status).toBe(409)
        expect(await store.claimed('greenhouse', shelves, undefined, 'first', async () => 'written')).toBe('written')
        // Once it's closed, or its session is gone, anyone may.
        store.hears = (_project, session) => session !== 'first'
        await store.claim('greenhouse', shelves, undefined, 'second')
        store.hears = () => true
        await store.updateIssue('greenhouse', shelves, {status: 'done'})
        await store.claim('greenhouse', shelves, undefined, 'second')
    })

    it("stays with its session when another writes to it, as a reviewer's comment does (ORR-627)", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-review'})).id
        await store.workedBy('greenhouse', shelves, 'first')
        await store.workedBy('greenhouse', shelves, 'reviewer')
        expect(await store.takenFrom('greenhouse', shelves, 'reviewer')).toBe('first')
        await store.claim('greenhouse', shelves, 'in-progress', 'first')
        // Once that session is gone, or the issue isn't started, the next one to write to it has it.
        store.hears = (_project, session) => session !== 'first'
        await store.workedBy('greenhouse', shelves, 'reviewer')
        store.hears = () => true
        expect(await store.takenFrom('greenhouse', shelves, 'first')).toBe('reviewer')
        await store.updateIssue('greenhouse', shelves, {status: 'todo'})
        await store.workedBy('greenhouse', shelves, 'first')
        await store.updateIssue('greenhouse', shelves, {status: 'in-review'})
        expect(await store.takenFrom('greenhouse', shelves, 'reviewer')).toBe('first')
    })

    it("is refused for a sub-issue while another session that's there has a parent above it started (ORR-611)", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-review'})).id
        const brackets = (await store.createIssue('greenhouse', {title: 'Brackets', parent: shelves})).id
        const screws = (await store.createIssue('greenhouse', {title: 'Screws', status: 'todo', parent: brackets})).id
        await store.workedBy('greenhouse', shelves, 'first')
        const refused = await failure(() => store.claim('greenhouse', screws, 'in-progress', 'second'))
        expect(refused).toEqual({status: 409, message: `${screws} is a sub-issue of ${shelves}, which another session (first) is working on; it's that session's to start; pick another issue`})
        // A comment on it isn't starting it; the parent's own session starts it.
        await store.claim('greenhouse', screws, undefined, 'second')
        await store.claim('greenhouse', screws, 'in-progress', 'first')
        // Once that session is gone, or the parent is done, anyone may.
        store.hears = (_project, session) => session !== 'first'
        await store.claim('greenhouse', screws, 'in-progress', 'second')
        store.hears = () => true
        await store.updateIssue('greenhouse', shelves, {status: 'done'})
        await store.claim('greenhouse', screws, 'in-progress', 'second')
    })

    it("goes to the session on a parent above it when it's a follow-up, and the owner's focus on another lets that one start it (ORR-613)", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-review'})).id
        const screws = (await store.createIssue('greenhouse', {title: 'Screws', status: 'todo', parent: shelves})).id
        const owner = {name: 'skoll', owner: true}
        await store.workedBy('greenhouse', shelves, 'first')
        expect(await store.heldAbove('greenhouse', screws)).toEqual({parent: shelves, holder: 'first'})
        expect(await store.heldAbove('greenhouse', screws, 'first')).toBeNull()
        // A focus aimed at nobody goes to the session on the parent.
        expect((await store.focus('greenhouse', screws, {}, owner)).target).toBe('first')
        // The owner aiming another session at it lets that one start it, and nobody else.
        await store.focus('greenhouse', screws, {session: 'second'}, owner)
        await store.claim('greenhouse', screws, 'in-progress', 'second')
        expect((await failure(() => store.claim('greenhouse', screws, 'in-progress', 'third'))).status).toBe(409)
    })

    it('goes to one session only when two start it at once', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        const start = (session: string) => store.claimed('greenhouse', shelves, 'in-progress', session, () => store.updateIssue('greenhouse', shelves, {status: 'in-progress'}))
        const sessions = ['first', 'second']
        const results = await Promise.allSettled(sessions.map(start))
        // Whichever comes first (the database decides) gets it; the other is refused.
        const won = results.findIndex(r => r.status === 'fulfilled')
        expect(won).toBeGreaterThanOrEqual(0)
        expect(results[1 - won]).toMatchObject({status: 'rejected', reason: {statusCode: 409}})
        const [winner, loser] = [sessions[won]!, sessions[1 - won]!]
        expect(await store.workingOn('greenhouse', [winner])).toHaveLength(1)
        expect(await store.workingOn('greenhouse', [loser])).toEqual([])
        // A refusal doesn't hold up the next write, and one without a status doesn't wait.
        await store.claimed('greenhouse', shelves, 'done', loser, () => store.updateIssue('greenhouse', shelves, {status: 'done'}))
        expect(await store.claimed('greenhouse', shelves, undefined, loser, async () => 'written')).toBe('written')
    })

    it("counts a session busy with an issue in progress, or a signal of the owner's waiting for it (ORR-501)", async () => {
        const owner: Actor = {name: 'skoll', owner: true}
        expect(await store.busy('greenhouse', ['s1'])).toBe(false)
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        await store.claimed('greenhouse', shelves, 'started', 's1', () => store.updateIssue('greenhouse', shelves, {status: 'started'}))
        expect(await store.busy('greenhouse', ['s1'])).toBe(true)
        expect(await store.busy('greenhouse', ['s2'])).toBe(false)
        await store.messageSession('greenhouse', 's2', 'Look at the shelves', owner)
        expect(await store.busy('greenhouse', ['s2'], true)).toBe(true)
        expect(await store.busy('greenhouse', ['s3'], true)).toBe(false)
    })

    it('goes to one session only when many start it at once, whichever started status each asks for (ORR-328)', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        const sessions = ['s1', 's2', 's3', 's4', 's5', 's6']
        const results = await Promise.allSettled(sessions.map((session, i) => {
            const status = i % 2 ? 'started' : 'in-progress'
            return store.claimed('greenhouse', shelves, status, session, () => store.updateIssue('greenhouse', shelves, {status}))
        }))
        const won = results.flatMap((r, i) => r.status === 'fulfilled' ? [sessions[i]!] : [])
        expect(won).toHaveLength(1)
        expect(results.filter(r => r.status === 'rejected').every(r => (r as PromiseRejectedResult).reason.statusCode === 409)).toBe(true)
        for (const session of sessions) expect((await store.workingOn('greenhouse', [session])).map(i => i.id)).toEqual(session === won[0] ? [shelves] : [])
        expect(await store.takenFrom('greenhouse', shelves, undefined)).toBe(won[0])
    })

    it('goes to one session when they start it by different ids for it, its own and an old one (ORR-328)', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        await store.db.run("INSERT INTO issue_aliases (project, alias, issue) VALUES ('greenhouse', 'GRE-99', ?)", shelves)
        const start = (session: string, id: string) => store.claimed('greenhouse', id, 'started', session, () => store.updateIssue('greenhouse', id, {status: 'started'}))
        const results = await Promise.allSettled([start('first', shelves), start('second', 'GRE-99')])
        expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    })

    it("refuses another session's comments and edits racing in once one has started it, and lets its own through (ORR-328)", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        await store.claimed('greenhouse', shelves, 'started', 'first', () => store.updateIssue('greenhouse', shelves, {status: 'started'}))
        const writes = await Promise.allSettled([
            store.claimed('greenhouse', shelves, undefined, 'second', async () => 'comment'),
            store.claimed('greenhouse', shelves, undefined, 'third', async () => 'edit'),
            store.claimed('greenhouse', shelves, 'todo', 'second', () => store.updateIssue('greenhouse', shelves, {status: 'todo'})),
            store.claimed('greenhouse', shelves, undefined, 'first', async () => 'its own'),
        ])
        expect(writes.map(r => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'fulfilled'])
        expect((await store.issue('greenhouse', shelves)).kind).toBe('started')
    })

    it('stays with its session after a /clear gives it a new id, and not with another (ORR-328)', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        await store.claimed('greenhouse', shelves, 'started', 'first', () => store.updateIssue('greenhouse', shelves, {status: 'started'}))
        await store.renameSession('greenhouse', 'first', 'first-cleared')
        expect(await store.takenFrom('greenhouse', shelves, 'first-cleared')).toBeNull()
        expect(await store.takenFrom('greenhouse', shelves, 'second')).toBe('first-cleared')
        expect((await failure(() => store.claim('greenhouse', shelves, 'started', 'second'))).status).toBe(409)
    })

    it('is held by one session again after it was refused: the loser can start another issue at once (ORR-328)', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        const jars = (await store.createIssue('greenhouse', {title: 'Jars', status: 'todo'})).id
        const start = (session: string, id: string) => store.claimed('greenhouse', id, 'started', session, () => store.updateIssue('greenhouse', id, {status: 'started'}))
        const [a, b] = await Promise.allSettled([start('first', shelves), start('second', shelves)])
        const loser = a.status === 'rejected' ? 'first' : 'second'
        expect([a, b].filter(r => r.status === 'rejected')).toHaveLength(1)
        await start(loser, jars)
        expect((await store.workingOn('greenhouse', [loser])).map(i => i.id)).toEqual([jars])
    })

    it('is free once the session on it is gone, or when it was never started', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-progress'})).id
        const jars = (await store.createIssue('greenhouse', {title: 'Jars', status: 'todo'})).id
        for (const issue of [shelves, jars]) await store.workedBy('greenhouse', issue, 'first')
        await store.claim('greenhouse', jars, 'started', 'second')
        store.hears = (_project, session) => session !== 'first'
        await store.claim('greenhouse', shelves, 'started', 'second')
    })

    it("stays with its session when the owner asks another to focus on it", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'todo'})).id
        await store.claimed('greenhouse', shelves, 'started', 'first', () => store.updateIssue('greenhouse', shelves, {status: 'started'}))
        await store.focus('greenhouse', shelves, {session: 'second'}, {name: 'skoll', owner: true})
        expect((await failure(() => store.claim('greenhouse', shelves, 'started', 'second'))).status).toBe(409)
        // Once the first is gone, the focus hands it over.
        store.hears = (_project, session) => session !== 'first'
        await store.focus('greenhouse', shelves, {session: 'second'}, {name: 'skoll', owner: true})
        store.hears = () => true
        await store.claim('greenhouse', shelves, 'started', 'second')
    })
})
