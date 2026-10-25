import {mkdtempSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {beforeEach, describe, expect, it} from 'vitest'
import {total} from '#shared/roadmap'
import {DEFAULT_CHUNK_PROMPT, DEFAULT_FOCUS_PROMPT} from '#shared/prompt'
import {backup, restoreBackup} from '../server/utils/backup'
import {openDb} from '../server/utils/db'
import {SqliteDb} from '../server/utils/database'
import {readRoadmap} from '../server/utils/roadmap'
import {Store} from '../server/utils/store'
import type {Actor} from '../server/utils/store'

let store: Store
let changes: string[]

beforeEach(async () => {
    changes = []
    store = new Store(new SqliteDb(openDb(':memory:')), project => changes.push(project))
    await store.createProject({name: 'larder', key: 'LAR'})
    await store.createChunk('larder', {title: 'Moving parts: joints'})
})

/** The status code and message a call fails with. */
async function failure(call: () => unknown): Promise<{status: number, message: string}> {
    try {
        await call()
    } catch (error) {
        const {statusCode, message} = error as {statusCode: number, message: string}
        return {status: statusCode, message}
    }
    throw new Error('it did not fail')
}

describe('projects', () => {
    it('makes an id and key from the name', async () => {
        const project = await store.createProject({name: 'Fitness App'})
        expect([project.id, project.key]).toEqual(['fitness-app', 'FIT'])
        expect((await failure(() => store.createProject({name: 'fitness app'}))).status).toBe(409)
    })

    it('refuses unknown fields', async () => {
        expect(await failure(() => store.createProject({name: 'x', colour: 'red'})))
            .toEqual({status: 400, message: 'unknown field "colour"; this takes id, name, key, description, icon, iconColor, focusPrompt, chunkPrompt, instructions, muted'})
    })

    it('keep an icon to set and clear', async () => {
        expect((await store.updateProject('larder', {icon: 'shopping-cart'})).icon).toBe('shopping-cart')
        expect((await failure(() => store.updateProject('larder', {icon: 'Cart Icon'}))).status).toBe(400)
        expect((await store.updateProject('larder', {icon: null})).icon).toBeUndefined()
    })

    it("keep an icon colour, a tint's name or a #rrggbb", async () => {
        expect((await store.updateProject('larder', {iconColor: 'teal'})).iconColor).toBe('teal')
        expect((await store.updateProject('larder', {iconColor: '#123abc'})).iconColor).toBe('#123abc')
        expect((await failure(() => store.updateProject('larder', {iconColor: 'red; background: url(x)'}))).status).toBe(400)
        expect((await store.updateProject('larder', {iconColor: null})).iconColor).toBeUndefined()
    })

    it('deletes everything in it', async () => {
        const issue = await store.createIssue('larder', {title: 'A'})
        await store.createComment('larder', issue.id, {body: 'hi'})
        await store.deleteProject('larder')
        expect(await store.listProjects()).toEqual([])
        expect(await store.db.get('SELECT count(*) AS n FROM comments')).toEqual({n: 0})
    })
})

describe('issues', () => {
    const add = async (body: Record<string, unknown>, actor?: Actor) => (await store.createIssue('larder', body, actor)).id

    it('get distinct numbers when made at the same time', async () => {
        const made = await Promise.all(Array.from({length: 8}, (_, i) => store.createIssue('larder', {title: `At once ${i}`})))
        expect(new Set(made.map(i => i.id)).size).toBe(8)
        expect((await store.createIssue('larder', {title: 'After'})).id).toBe('LAR-9')
    })

    it('get the project prefix and the next number, and land in a column', async () => {
        const a = await store.createIssue('larder', {title: 'Joint editor', chunk: '1', status: 'todo', priority: 'P1'})
        const b = await store.createIssue('larder', {title: 'Unplanned'})
        expect([a.id, a.column, a.chunk]).toEqual(['LAR-1', 'todo', '1'])
        expect([b.id, b.column, b.chunk]).toEqual(['LAR-2', 'backlog', null])
        expect((await store.project('larder')).board.chunks.map(c => c.title)).toEqual(['Moving parts: joints', 'No chunk'])
        expect(changes.at(-1)).toBe('larder')
    })

    it("can't be given an id", async () => {
        expect((await failure(() => store.createIssue('larder', {id: 'MOT-5', title: 'x'}))).message).toMatch(/^unknown field "id"/)
        expect((await failure(() => store.createChunk('larder', {id: 'joints', title: 'x'}))).message).toMatch(/^unknown field "id"/)
    })

    it('nest in their parent and its chunk', async () => {
        const parent = await add({title: 'Joints', chunk: '1', status: 'todo'})
        const hinge = await add({title: 'Hinge', parent, status: 'in-progress'})
        const slider = await add({title: 'Slider', parent, status: 'done'})

        const shown = await store.issue('larder', parent)
        expect(shown.column).toBe('in-progress')
        expect(shown.tasks.map(t => t.id)).toEqual([hinge, slider])
        expect([shown.kinds.done, total(shown.kinds)]).toEqual([1, 2])
        expect(await store.issue('larder', hinge)).toMatchObject({parent, chunk: '1'})
        expect((await store.listIssues('larder', {parent: 'none'})).map(i => i.id)).toEqual([parent])
        expect((await failure(() => add({title: 'x', parent, chunk: '1'}))).status).toBe(400)
    })

    it("can't become their own ancestor", async () => {
        const a = await add({title: 'A'})
        const b = await add({title: 'B', parent: a})
        expect((await failure(() => store.updateIssue('larder', a, {parent: b}))).message).toBe(`${b} is under this issue, so it can't be its parent`)
        expect((await failure(() => store.updateIssue('larder', a, {parent: a}))).status).toBe(400)
    })

    it('lift into the chunk they were in', async () => {
        const a = await add({title: 'A', chunk: '1'})
        const b = await add({title: 'B', parent: a})
        expect(await store.updateIssue('larder', b, {parent: null})).toMatchObject({parent: null, chunk: '1'})
    })

    it('clear fields with null and go with their parent', async () => {
        const a = await add({title: 'A', priority: 'P1'})
        await add({title: 'B', parent: a})
        expect((await store.updateIssue('larder', a, {priority: null})).priority).toBeUndefined()
        await store.deleteIssue('larder', a)
        expect(await store.listIssues('larder')).toEqual([])
    })

    it('keep an assignee and labels, and filter by them', async () => {
        const a = await add({title: 'A', assignee: 'claude', labels: ['bug', 'ui', 'bug']})
        const b = await add({title: 'B'})
        expect(await store.issue('larder', a)).toMatchObject({assignee: 'claude', labels: ['bug', 'ui']})
        expect((await store.listIssues('larder', {label: 'ui'})).map(i => i.id)).toEqual([a])
        expect((await store.listIssues('larder', {assignee: 'none'})).map(i => i.id)).toEqual([b])
        expect(await store.updateIssue('larder', a, {labels: null, assignee: null})).toMatchObject({labels: [], assignee: undefined})
        expect((await failure(() => add({title: 'x', labels: 'bug'}))).status).toBe(400)
    })

    it("move to another project with their sub-issues and comments, taking that project's ids", async () => {
        await store.createProject({name: 'orrery', key: 'ORR'})
        await store.createChunk('orrery', {title: 'v1'})
        await store.createIssue('orrery', {title: 'already there'})
        const a = await add({title: 'A', chunk: '1'})
        const b = await add({title: 'B', parent: a})
        await store.createComment('larder', b, {body: 'hi'})

        const moved = await store.updateIssue('larder', a, {project: 'orrery', chunk: '1', priority: 'P2'})
        expect(moved).toMatchObject({id: 'ORR-2', project: 'orrery', chunk: '1', parent: null, priority: 'P2', aliases: ['LAR-1']})
        expect(moved.tasks.map(t => t.id)).toEqual(['ORR-3'])
        expect((await store.listComments('orrery', b)).map(c => c.body)).toEqual(['hi'])
        expect((await store.issue('orrery', 'LAR-1')).id).toBe('ORR-2')
        expect(await store.listIssues('larder')).toEqual([])
        expect(changes.slice(-3)).toEqual(['larder', 'orrery', 'orrery'])
    })

    it('stay when their chunk is deleted', async () => {
        const a = await add({title: 'A', chunk: '1'})
        await store.deleteChunk('larder', '1')
        expect((await store.issue('larder', a)).chunk).toBeNull()
    })
})

describe('comments', () => {
    it('list, show, update and delete', async () => {
        const a = (await store.createIssue('larder', {title: 'A'})).id
        const comment = await store.createComment('larder', a, {body: 'Started on `joints.rs`'}, {name: 'claude', owner: false})
        expect(comment.createdBy).toBe('claude')
        expect((await store.issue('larder', a)).comments).toBe(1)
        expect((await store.updateComment('larder', a, comment.id, {body: 'Done'})).body).toBe('Done')
        expect((await store.listComments('larder', a)).map(c => c.body)).toEqual(['Done'])
        await store.deleteComment('larder', a, comment.id)
        expect((await failure(() => store.comment('larder', a, comment.id))).status).toBe(404)
    })
})

describe('activity', () => {
    const owner: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}
    const changed = async (issue: string, project = 'larder') => (await store.listActivity(project, issue)).map(e => [e.field, e.before, e.after, e.createdBy])

    it('notes who changed which field, from what to what', async () => {
        const {id} = await store.createIssue('larder', {title: 'A', notes: 'first'}, owner)
        await store.updateIssue('larder', id, {title: 'A', status: 'in-progress', assignee: 'claude', priority: 'P2'}, claude)
        await store.updateIssue('larder', id, {notes: 'second', labels: ['ui'], chunk: '1'}, claude)
        await store.updateIssue('larder', id, {notes: 'second', priority: null}, owner)
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
        expect((await store.listActivity('larder', id))[0]).toMatchObject({issue: id, protected: true})
    })

    it('notes a new parent, not the chunk that comes with it', async () => {
        const parent = (await store.createIssue('larder', {title: 'P', chunk: '1'})).id
        const {id} = await store.createIssue('larder', {title: 'A', chunk: '1'})
        await store.updateIssue('larder', id, {parent})
        await store.updateIssue('larder', id, {parent: null})
        expect((await changed(id)).slice(1)).toEqual([['parent', undefined, parent, 'agent'], ['parent', parent, undefined, 'agent']])
    })

    it('notes decisions and the assignee an ask hands over', async () => {
        const {id} = await store.createIssue('larder', {title: 'Button', proposal: 'pending'}, claude)
        await store.decide('larder', id, {decision: 'approved'}, owner)
        await store.createComment('larder', id, {body: 'Ship it?', asks: 'decision'}, claude)
        expect((await changed(id)).slice(1)).toEqual([
            ['proposal', 'pending', 'approved', 'skoll'],
            ['assignee', 'owner', 'claude', 'skoll'],
            ['assignee', 'claude', 'owner', 'claude'],
        ])
    })

    it('moves with the issue to another project, and goes when it does', async () => {
        await store.createProject({name: 'orrery', key: 'ORR'})
        const {id} = await store.createIssue('larder', {title: 'A'})
        const moved = await store.updateIssue('larder', id, {project: 'orrery'}, owner)
        expect(await changed(moved.id, 'orrery')).toEqual([['created', undefined, undefined, 'agent'], ['project', 'larder', 'orrery', 'skoll']])
        await store.deleteIssue('orrery', moved.id, owner)
        expect(await store.db.get('SELECT count(*) AS n FROM issue_events')).toEqual({n: 0})
    })
})

describe('proposals', () => {
    const owner: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}

    it('sit in Proposed with their sub-issues, out of the committed work', async () => {
        const proposal = await store.createIssue('larder', {title: 'Button', proposal: 'pending', chunk: '1'})
        await store.createIssue('larder', {title: 'Its states', parent: proposal.id, status: 'todo'})
        await store.createIssue('larder', {title: 'Work', chunk: '1', status: 'todo'})
        const {board} = await store.project('larder')
        expect([(await store.issue('larder', proposal.id)).column, board.kinds.proposed, total(board.kinds)]).toEqual(['proposed', 1, 1])
        expect((await store.listIssues('larder', {proposal: 'none'})).map(i => i.title)).toEqual(['Work'])
    })

    it("are decided by the owner, who's heard by the session on them", async () => {
        const {id} = await store.createIssue('larder', {title: 'Button', proposal: 'pending'}, claude)
        expect((await failure(() => store.decide('larder', id, {decision: 'approved'}, claude))).status).toBe(403)
        const decided = await store.decide('larder', id, {decision: 'changes', note: 'Rounder corners'}, owner)
        expect([decided.proposal, decided.decidedBy, decided.decisionNote, decided.column]).toEqual(['changes', 'skoll', 'Rounder corners', 'proposed'])
        expect((await store.listComments('larder', id)).at(-1)?.body).toBe('Asked for changes to this proposal.\n\nRounder corners')
        // Put up again, it waits on a new decision.
        expect((await store.updateIssue('larder', id, {proposal: 'pending'}, claude)).decidedBy).toBeUndefined()
        const work = (await store.createIssue('larder', {title: 'Work'})).id
        expect((await failure(() => store.decide('larder', work, {decision: 'approved'}, owner))).status).toBe(400)
    })

    it('are committed once approved, or by the owner', async () => {
        const {id} = await store.createIssue('larder', {title: 'Button', proposal: 'pending'})
        expect((await failure(() => store.updateIssue('larder', id, {proposal: null}, claude))).status).toBe(403)
        await store.decide('larder', id, {decision: 'approved'}, owner)
        const committed = await store.updateIssue('larder', id, {proposal: null, status: 'todo'}, claude)
        expect([committed.proposal, committed.column, committed.decidedBy]).toEqual([undefined, 'todo', 'skoll'])
        const other = await store.createIssue('larder', {title: 'Card', proposal: 'pending'})
        expect((await store.updateIssue('larder', other.id, {proposal: null}, owner)).column).toBe('backlog')
    })

    it("are the owner's until decided, then back with whoever proposed them", async () => {
        const {id} = await store.createIssue('larder', {title: 'Button', proposal: 'pending'}, claude)
        expect((await store.issue('larder', id)).assignee).toBe('owner')
        expect((await store.decide('larder', id, {decision: 'changes'}, owner)).assignee).toBe('claude')
        expect((await store.updateIssue('larder', id, {proposal: 'pending'}, claude)).assignee).toBe('owner')
        expect((await store.createIssue('larder', {title: 'Card', proposal: 'pending', assignee: 'claude'}, claude)).assignee).toBe('owner')
        const {id: tag} = await store.createIssue('larder', {title: 'Tag', assignee: 'claude'}, claude)
        expect((await store.updateIssue('larder', tag, {proposal: 'pending', assignee: 'claude'}, claude)).assignee).toBe('owner')
    })
})

describe("the owner's things", () => {
    const me: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}
    const add = async (body: Record<string, unknown>, actor: Actor) => (await store.createIssue('larder', body, actor)).id

    it('record who made them', async () => {
        expect(await store.createIssue('larder', {title: 'A'}, me)).toMatchObject({createdBy: 'skoll', protected: true})
        expect(await store.createIssue('larder', {title: 'B'}, claude)).toMatchObject({createdBy: 'claude', protected: false})
    })

    it("can't be deleted by an agent, directly or with what holds them", async () => {
        const a = await add({title: 'A'}, claude)
        const b = await add({title: 'B', parent: a}, me)
        const comment = await store.createComment('larder', a, {body: 'mine'}, me)

        expect(await failure(() => store.deleteIssue('larder', b, claude))).toEqual({status: 403, message: `Deleting ${b} is the owner's call: ${b} was made by the owner`})
        expect((await failure(() => store.deleteIssue('larder', a, claude))).message).toBe(`Deleting ${a} is the owner's call: ${b}, comment ${comment.id} on ${a} were made by the owner`)
        expect((await failure(() => store.deleteComment('larder', a, comment.id, claude))).status).toBe(403)
        expect((await failure(() => store.updateComment('larder', a, comment.id, {body: 'not yours'}, claude))).status).toBe(403)
        expect((await failure(() => store.deleteProject('larder', claude))).status).toBe(403)
        expect((await failure(() => store.importRoadmap('larder', {comment: '', chunks: []}, true, claude))).status).toBe(403)

        await store.deleteIssue('larder', a, me)
        expect(await store.listIssues('larder')).toEqual([])
    })

    it('leave what agents made deletable', async () => {
        const a = await add({title: 'A'}, claude)
        await store.deleteIssue('larder', a, {name: 'codex', owner: false})
        expect(await store.listIssues('larder')).toEqual([])
    })
})

describe("the owner's name", () => {
    const owner: Actor = {name: 'owner', owner: true}
    const claude: Actor = {name: 'claude', owner: false}

    it("is unset until it's given, with the id it had before", async () => {
        expect(await store.ownerOf()).toEqual({name: 'owner', display: 'owner', named: false})
    })

    it('makes a lowercase snake-case id, and moves what was theirs to it', async () => {
        const mine = await store.createIssue('larder', {title: 'Mine'}, owner)
        const proposed = await store.createIssue('larder', {title: 'A', proposal: 'pending'}, claude)
        expect((await store.issue('larder', proposed.id)).assignee).toBe('owner')

        expect(await store.nameOwner({name: 'Sköll Fenrisson'}, claude)).toEqual({name: 'skoll_fenrisson', display: 'Sköll Fenrisson', named: true})
        expect((await store.issue('larder', mine.id)).createdBy).toBe('skoll_fenrisson')
        expect((await store.issue('larder', proposed.id)).assignee).toBe('skoll_fenrisson')
        expect((await store.issue('larder', mine.id)).protected).toBe(true)
    })

    it('is who `owner` means as an assignee, so agents needn\'t know the id', async () => {
        await store.nameOwner({name: 'Sköll Fenrisson'})
        const a = await store.createIssue('larder', {title: 'A', assignee: 'owner'}, claude)
        expect(a.assignee).toBe('skoll_fenrisson')
        const b = await store.createIssue('larder', {title: 'B'}, claude)
        expect((await store.updateIssue('larder', b.id, {assignee: 'Owner'}, claude)).assignee).toBe('skoll_fenrisson')
        expect((await store.listIssues('larder', {assignee: 'owner'})).map(i => i.id)).toEqual([a.id, b.id])
        expect((await store.updateIssue('larder', b.id, {assignee: 'claude'}, claude)).assignee).toBe('claude')
    })

    it('is only the owner\'s to change once given', async () => {
        await store.nameOwner({name: 'Skoll'})
        expect((await failure(() => store.nameOwner({name: 'Hati'}, claude))).status).toBe(403)
        expect((await store.nameOwner({name: 'Hati'}, {name: 'skoll', owner: true})).name).toBe('hati')
    })

    it('needs a letter or a digit, and not the name requests without one get', async () => {
        expect((await failure(() => store.nameOwner({name: '!!'}))).status).toBe(400)
        expect((await failure(() => store.nameOwner({name: 'Agent'}))).status).toBe(400)
    })
})

describe("the owner's comments", () => {
    it('go to the session last asked to focus on the issue, or to all', async () => {
        const sent: string[] = []
        const local = new Store(new SqliteDb(openDb(':memory:')), () => {}, signal => sent.push(`${signal.kind}:${signal.target ?? 'all'}:${signal.note}`))
        await local.createProject({name: 'larder', key: 'LAR'})
        const me = {name: 'skoll', owner: true}
        const {id} = await local.createIssue('larder', {title: 'A'})
        await local.createComment('larder', id, {body: 'first'}, me)
        await local.focus('larder', id, {session: 'joints-window'}, me)
        await local.createComment('larder', id, {body: 'second'}, me)
        await local.createComment('larder', id, {body: 'from an agent'}, {name: 'claude', owner: false})
        expect(sent).toEqual(['comment:all:first', 'focus:joints-window:undefined', 'comment:joints-window:second'])
    })
})

describe('chunks', () => {
    it('have a priority to set and clear', async () => {
        expect((await store.chunk('larder', '1')).priority).toBeUndefined()
        expect((await store.updateChunk('larder', '1', {priority: 'P1'})).priority).toBe('P1')
        expect((await store.project('larder')).board.chunks[0]!.priority).toBe('P1')
        expect((await store.updateChunk('larder', '1', {priority: null})).priority).toBeUndefined()
        expect((await failure(() => store.updateChunk('larder', '1', {priority: 'P7'}))).status).toBe(400)
    })

    it('can be focused on, by their id or a name they had', async () => {
        const sent: string[] = []
        const local = new Store(new SqliteDb(openDb(':memory:')), () => {}, signal => sent.push(`${signal.kind}:${signal.issue ?? '-'}:${signal.chunk}:${signal.target ?? 'all'}`))
        await local.createProject({name: 'larder', key: 'LAR'})
        await local.createChunk('larder', {title: 'Joints'})
        const signal = await local.focusChunk('larder', '1', {session: 'joints-window', note: 'urgent'}, {name: 'skoll', owner: true})
        expect(signal).toMatchObject({chunk: '1', kind: 'focus', note: 'urgent', protected: true})
        expect(signal.issue).toBeUndefined()
        expect(sent).toEqual(['focus:-:1:joints-window'])
        expect((await local.listSignals('larder', 0, 50, {chunk: '1'})).map(s => s.id)).toEqual([signal.id])
        expect((await failure(() => local.focusChunk('larder', '9', {}))).status).toBe(404)
        expect((await local.focusChunk('larder', 'none', {})).chunk).toBe('none')
    })

    it('can be focused on for their issues of one status', async () => {
        const local = new Store(new SqliteDb(openDb(':memory:')), () => {})
        await local.createProject({name: 'larder', key: 'LAR'})
        await local.createChunk('larder', {title: 'Joints'})
        expect((await local.focusChunk('larder', '1', {status: 'todo'}, {name: 'skoll', owner: true})).status).toBe('todo')
        expect((await local.focusChunk('larder', '1', {})).status).toBeUndefined()
        expect((await failure(() => local.focusChunk('larder', '1', {status: 'done'}))).status).toBe(400)
        expect((await failure(() => local.focusChunk('larder', '1', {status: 'soon'}))).status).toBe(400)
    })
})

describe('what sessions are told', () => {
    const owner: Actor = {name: 'skoll', owner: true}

    it("uses the project's templates, else the Orrery's, else the defaults", async () => {
        expect(await store.prompts('larder')).toEqual({focus: DEFAULT_FOCUS_PROMPT, chunk: DEFAULT_CHUNK_PROMPT})
        await store.updateSettings({focusPrompt: 'Look at {issue}.'}, owner)
        await store.updateProject('larder', {chunkPrompt: 'Do chunk {chunk}.'}, owner)
        expect(await store.prompts('larder')).toEqual({focus: 'Look at {issue}.', chunk: 'Do chunk {chunk}.'})
        await store.updateProject('larder', {chunkPrompt: '  '}, owner)
        await store.updateSettings({focusPrompt: ''}, owner)
        expect(await store.prompts('larder')).toEqual({focus: DEFAULT_FOCUS_PROMPT, chunk: DEFAULT_CHUNK_PROMPT})
    })

    it("are the owner's to change", async () => {
        expect((await failure(() => store.updateProject('larder', {focusPrompt: 'x'}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await failure(() => store.updateSettings({instructions: []}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await store.updateProject('larder', {description: 'still fine'})).description).toBe('still fine')
    })

    it('add the standing instructions ticked by default, or those picked for the send', async () => {
        const {instructions: [commit, branch]} = await store.updateSettings({instructions: [{text: 'Commit whenever a piece works'}, {text: 'Make a branch', on: false}]}, owner)
        expect([commit!.on, branch!.on, commit!.id]).toEqual([true, false, expect.stringMatching(/^[0-9a-f]{8}$/)])
        const {instructions: [tests]} = await store.updateProject('larder', {instructions: [{text: 'Run the tests'}]}, owner)
        const {id} = await store.createIssue('larder', {title: 'A'})
        expect((await store.focus('larder', id, {}, owner)).instructions).toEqual(['Commit whenever a piece works', 'Run the tests'])
        await store.updateProject('larder', {muted: [commit!.id]}, owner)
        expect((await store.focus('larder', id, {}, owner)).instructions).toEqual(['Run the tests'])
        expect((await store.focusChunk('larder', '1', {instructions: [branch!.id, tests!.id]}, owner)).instructions).toEqual(['Make a branch', 'Run the tests'])
        expect((await store.focus('larder', id, {instructions: []}, owner)).instructions).toEqual([])
        expect((await failure(() => store.focus('larder', id, {instructions: ['nope']}, owner))).status).toBe(400)
        expect((await failure(() => store.updateSettings({instructions: [{text: ''}]}, owner))).status).toBe(400)
    })
})

describe('the bell', () => {
    it("clears agents' comments by id or up to a time, leaving them on their issues", async () => {
        const {id} = await store.createIssue('larder', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        const first = await store.createComment('larder', id, {body: 'one'}, agent)
        await store.createComment('larder', id, {body: 'two'}, agent)
        await store.createComment('larder', id, {body: 'mine'}, {name: 'skoll', owner: true})
        expect(await store.clearNotices({ids: [first.id]})).toBe(1)
        expect((await store.notices()).map(n => n.body)).toEqual(['two'])
        expect(await store.clearNotices({before: new Date(Date.now() + 1000).toISOString()})).toBe(1)
        expect(await store.notices()).toEqual([])
        expect(await store.listComments('larder', id)).toHaveLength(3)
        expect((await store.notices(null, true)).map(n => [n.body, n.cleared])).toEqual([['two', true], ['one', true]])
        expect((await failure(() => store.clearNotices({}))).status).toBe(400)
    })
})

describe('comments that wait on the owner', () => {
    it('lead the bell until the owner answers, and survive Clear read', async () => {
        const {id} = await store.createIssue('larder', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        await store.createComment('larder', id, {body: 'note'}, agent)
        const ask = await store.createComment('larder', id, {body: 'Ship it?', asks: 'decision'}, agent)
        await store.createComment('larder', id, {body: 'later note'}, agent)
        expect(ask).toMatchObject({asks: 'decision'})
        expect((await store.notices()).map(n => [n.body, n.answered])).toEqual([['Ship it?', false], ['later note', undefined], ['note', undefined]])
        await store.clearNotices({before: new Date(Date.now() + 1000).toISOString()})
        expect((await store.notices()).map(n => n.body)).toEqual(['Ship it?'])
        await store.createComment('larder', id, {body: 'Yes'}, {name: 'skoll', owner: true})
        expect((await store.notices())[0]).toMatchObject({body: 'Ship it?', answered: true})
        expect((await store.listComments('larder', id)).find(c => c.id === ask.id)).toMatchObject({asks: 'decision', answered: true})
        expect((await failure(() => store.createComment('larder', id, {body: 'x', asks: 'vibes'}, agent))).status).toBe(400)
    })

    it("make the issue the owner's until they answer, then the asker's again", async () => {
        const {id} = await store.createIssue('larder', {title: 'A', assignee: 'claude'})
        const agent = {name: 'claude', owner: false}
        const skoll = {name: 'skoll', owner: true}
        await store.createComment('larder', id, {body: 'note'}, agent)
        expect((await store.issue('larder', id)).assignee).toBe('claude')
        await store.createComment('larder', id, {body: 'Ship it?', asks: 'decision'}, agent)
        expect((await store.issue('larder', id)).assignee).toBe('owner')
        await store.createComment('larder', id, {body: 'Yes'}, skoll)
        expect((await store.issue('larder', id)).assignee).toBe('claude')
        // Answered already, so a later word from the owner leaves it with the agent.
        await store.updateIssue('larder', id, {assignee: 'owner'}, skoll)
        await store.createComment('larder', id, {body: 'Mine now'}, skoll)
        expect((await store.issue('larder', id)).assignee).toBe('owner')
    })
})

describe("an owner's comment", () => {
    const owner = {name: 'skoll', owner: true}

    it('goes to the session that last worked the issue, while it can hear; else to every session', async () => {
        const sent: (string | undefined)[] = []
        const local = new Store(new SqliteDb(openDb(':memory:')), () => {}, signal => signal.kind === 'comment' && sent.push(signal.target))
        let listening = ['window-a', 'window-b']
        local.hears = (_project, session) => listening.includes(session)
        await local.createProject({name: 'larder', key: 'LAR'})
        const {id} = await local.createIssue('larder', {title: 'Shelves'})
        await local.createComment('larder', id, {body: 'nobody yet'}, owner)
        await local.workedBy('larder', id, 'window-a')
        await local.createComment('larder', id, {body: 'a has it'}, owner)
        await local.focus('larder', id, {session: 'window-b'}, owner)
        await local.createComment('larder', id, {body: 'b was asked'}, owner)
        listening = ['window-a']
        await local.createComment('larder', id, {body: 'b is gone'}, owner)
        expect(sent).toEqual([undefined, 'window-a', 'window-b', undefined])
        // Noting a worker on an issue that isn't there does nothing.
        await local.workedBy('larder', 'LAR-99', 'window-a')
    })
})

describe('statuses', () => {
    const owner = {name: 'skoll', owner: true}

    it('start as Backlog, Todo, In progress, In review, Done and Canceled, in board order', async () => {
        expect((await store.statuses()).map(s => `${s.id}:${s.kind}`)).toEqual(['backlog:backlog', 'todo:todo', 'in-progress:started', 'in-review:started', 'done:done', 'canceled:canceled'])
        expect((await store.settings()).statuses).toHaveLength(6)
    })

    it('take an id, a kind, or the words from before statuses', async () => {
        const status = async (body: Record<string, unknown>) => (await store.createIssue('larder', {title: 'x', ...body})).status
        expect(await status({status: 'in-review'})).toBe('in-review')
        expect(await status({status: 'started'})).toBe('in-progress')
        expect(await status({status: 'doing'})).toBe('in-progress')
        expect(await status({status: 'todo', plan: 'next'})).toBe('todo')
        expect(await status({status: 'todo', plan: null})).toBe('backlog')
        expect(await status({plan: 'now'})).toBe('todo')
        expect(await status({})).toBe('backlog')
        expect((await failure(() => status({status: 'soon'}))).status).toBe(400)
        const a = (await store.createIssue('larder', {title: 'A', status: 'todo'})).id
        expect((await store.updateIssue('larder', a, {status: 'canceled'})).kind).toBe('canceled')
        expect((await store.listIssues('larder', {status: 'started'})).map(i => i.status)).toEqual(['in-review', 'in-progress', 'in-progress'])
        expect((await store.listIssues('larder', {column: 'canceled'})).map(i => i.id)).toEqual([a])
    })

    it("are the owner's to add, change and remove, keeping one of each kind", async () => {
        const claude = {name: 'claude', owner: false}
        expect((await failure(() => store.createStatus({name: 'Blocked', kind: 'started'}, claude))).status).toBe(403)
        const blocked = await store.createStatus({name: 'Blocked', kind: 'started', color: 'rose'}, owner)
        expect(blocked).toMatchObject({id: 'blocked', name: 'Blocked', kind: 'started', color: 'rose'})
        expect((await store.statuses()).map(s => s.id)).toEqual(['backlog', 'todo', 'in-progress', 'in-review', 'blocked', 'done', 'canceled'])
        expect((await failure(() => store.createStatus({name: 'Blocked', kind: 'started'}, owner))).status).toBe(409)
        expect((await failure(() => store.createStatus({name: 'Proposed', kind: 'todo'}, owner))).status).toBe(400)
        expect(await store.updateStatus('blocked', {name: 'Stuck', color: '#ff0000'}, owner)).toMatchObject({id: 'blocked', name: 'Stuck', color: '#ff0000'})
        expect((await failure(() => store.updateStatus('todo', {kind: 'started'}, owner))).status).toBe(409)

        const id = (await store.createIssue('larder', {title: 'Stuck', status: 'blocked'})).id
        expect((await failure(() => store.deleteStatus('blocked', undefined, owner))).status).toBe(409)
        await store.deleteStatus('blocked', 'in-progress', owner)
        expect((await store.issue('larder', id)).status).toBe('in-progress')
        expect((await failure(() => store.deleteStatus('todo', 'backlog', owner))).status).toBe(409)
        expect((await failure(() => store.status('blocked'))).status).toBe(404)
    })

    it('narrow a chunk focus to an open one, by id or kind', async () => {
        const signal = async (status: string) => (await store.focusChunk('larder', '1', {status}, owner)).status
        expect(await signal('in-review')).toBe('in-review')
        expect(await signal('started')).toBe('started')
        expect((await failure(() => signal('done'))).status).toBe(400)
        expect((await failure(() => signal('canceled'))).status).toBe(400)
    })
})

describe('settings', () => {
    it('keep a tint, the owner’s to change', async () => {
        expect((await store.settings()).tint).toBeNull()
        expect((await store.updateSettings({tint: 'blue'}, {name: 'skoll', owner: true})).tint).toBe('blue')
        expect((await store.updateSettings({tint: '#123abc'}, {name: 'skoll', owner: true})).tint).toBe('#123abc')
        expect((await failure(() => store.updateSettings({tint: 'red; background: url(x)'}, {name: 'skoll', owner: true}))).status).toBe(400)
        expect((await failure(() => store.updateSettings({tint: null}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await store.updateSettings({tint: null}, {name: 'skoll', owner: true})).tint).toBeNull()
    })
})

describe('removing', () => {
    it('an issue takes its signals with it', async () => {
        const {id} = await store.createIssue('larder', {title: 'A'})
        await store.focus('larder', id, {}, {name: 'skoll', owner: true})
        await store.deleteIssue('larder', id, {name: 'skoll', owner: true})
        expect(await store.listSignals('larder')).toEqual([])
    })
})

describe('a session that connects', () => {
    it("gets the owner's comments that no agent has answered", async () => {
        const sent: string[] = []
        const local = new Store(new SqliteDb(openDb(':memory:')), () => {}, signal => sent.push(`${signal.issue}:${signal.target}:${signal.note}`))
        await local.createProject({name: 'larder', key: 'LAR'})
        const me = {name: 'skoll', owner: true}
        const a = (await local.createIssue('larder', {title: 'A'})).id
        const b = (await local.createIssue('larder', {title: 'B'})).id
        await local.createComment('larder', a, {body: 'answer me'}, me)
        await local.createComment('larder', b, {body: 'answered'}, me)
        await local.createComment('larder', b, {body: 'here you go'}, {name: 'claude', owner: false})
        sent.length = 0
        expect(await local.carryUnanswered('larder', 'new-window')).toBe(1)
        expect(sent).toEqual([`${a}:new-window:answer me`])
    })
})

describe('docs', () => {
    it('are listed with the project, without their text', async () => {
        const doc = await store.createDoc('larder', {title: 'How joints work', body: '# Joints\n\nA **hinge** turns.'})
        expect(doc).toMatchObject({id: 'how-joints-work', createdBy: 'agent', protected: false})
        expect((await store.project('larder')).docs.map(d => d.id)).toEqual(['how-joints-work'])
        expect((await store.project('larder')).docs[0]).not.toHaveProperty('body')
        expect((await store.doc('larder', doc.id)).body).toContain('**hinge**')
    })

    it('are created or replaced at their id with PUT', async () => {
        expect((await store.putDoc('larder', 'readme', {title: 'Readme', body: 'one'})).created).toBe(true)
        const {doc, created} = await store.putDoc('larder', 'readme', {title: 'README', body: 'two'})
        expect([created, doc.title, doc.body]).toEqual([false, 'README', 'two'])
        expect((await failure(() => store.putDoc('larder', 'Bad Id', {title: 'x'}))).status).toBe(400)
    })

    it("are the owner's to delete when the owner wrote them", async () => {
        await store.createDoc('larder', {id: 'mine', title: 'Mine'}, {name: 'skoll', owner: true})
        expect((await failure(() => store.deleteDoc('larder', 'mine'))).status).toBe(403)
        expect((await failure(() => store.deleteProject('larder'))).status).toBe(403)
        await store.deleteDoc('larder', 'mine', {name: 'skoll', owner: true})
        expect(await store.listDocs('larder')).toEqual([])
    })
})

describe('the database', () => {
    it('keeps its data through the migrations and gives it project ids, the old ones as aliases', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 2)
        const row = (sql: string) => old.prepare(sql).run()
        row("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('larder', 'larder', 'LAR', 'agent', 'x', 'x')")
        row("INSERT INTO chunks (project, id, title, position, created_by, created_at, updated_at) VALUES ('larder', 'ux', 'UX', 1, 'agent', 'x', 'x')")
        row("INSERT INTO chunks (project, id, title, position, created_by, created_at, updated_at) VALUES ('larder', 'joints', 'Joints', 0, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, chunk, position, created_by, created_at, updated_at) VALUES ('larder', 'UX-1', 'ux', 'ux', 0, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, chunk, position, created_by, created_at, updated_at) VALUES ('larder', 'MOT-5', 'joint', 'joints', 1, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, parent, position, created_by, created_at, updated_at) VALUES ('larder', 'LAR-1', 'sub', 'MOT-5', 2, 'agent', 'x', 'x')")
        row("INSERT INTO comments (project, issue, body, created_by, created_at, updated_at) VALUES ('larder', 'MOT-5', 'hi', 'agent', 'x', 'x')")
        old.close()

        const upgraded = new Store(new SqliteDb(openDb(path)))
        const {board} = await upgraded.project('larder')
        expect(board.chunks.map(c => [c.id, c.title, c.aliases])).toEqual([['1', 'Joints', ['joints']], ['2', 'UX', ['ux']]])
        // LAR-1 was already the project's kind of id, so it keeps it; the others take the next numbers.
        expect(board.chunks[0]!.tasks.map(t => [t.id, t.aliases, t.tasks.map(s => s.id)])).toEqual([['LAR-2', ['MOT-5'], ['LAR-1']]])
        expect(board.chunks[1]!.tasks.map(t => [t.id, t.aliases])).toEqual([['LAR-3', ['UX-1']]])
        expect((await upgraded.issue('larder', 'MOT-5')).id).toBe('LAR-2')
        expect((await upgraded.listComments('larder', 'MOT-5')).map(c => c.body)).toEqual(['hi'])
        expect((await upgraded.chunk('larder', 'joints')).id).toBe('1')
        expect(await upgraded.createIssue('larder', {title: 'new', chunk: 'ux'})).toMatchObject({id: 'LAR-4', chunk: '2'})
        expect((await upgraded.createChunk('larder', {title: 'Print'})).id).toBe('3')
        expect((await upgraded.updateIssue('larder', 'LAR-4', {priority: 'P0'})).priority).toBe('P0')
    })

    it('is backed up to a folder and restored from it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
        const {id} = await store.createIssue('larder', {title: 'saved'})
        backup((store.db as SqliteDb).raw, join(dir, 'cloud'))

        const fresh = join(dir, 'new', 'orrery.db')
        restoreBackup(fresh, join(dir, 'cloud'))
        expect((await new Store(new SqliteDb(openDb(fresh))).issue('larder', id)).title).toBe('saved')
    })
})

describe('import', () => {
    const roadmap = readRoadmap(readFileSync(new URL('./fixtures/larder-roadmap.json', import.meta.url), 'utf8'))

    it("loads larder's roadmap", async () => {
        expect((await failure(() => store.importRoadmap('larder', roadmap))).status).toBe(409)
        const {board} = await store.importRoadmap('larder', roadmap, true)
        expect(board.chunks).toHaveLength(16)
        expect(total(board.kinds)).toBe(139)
        expect(board.chunks.map(c => c.id)).toEqual(Array.from({length: 16}, (_, i) => String(i + 1)))
        expect(board.chunks[0]!.tasks[0]).toMatchObject({id: 'LAR-1', aliases: ['FIX-1']})
        expect((await store.issue('larder', 'MOT-5')).aliases).toEqual(['MOT-5'])
        expect((await store.createIssue('larder', {title: 'next'})).id).toBe('LAR-140')
    })
})
