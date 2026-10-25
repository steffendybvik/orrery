import {mkdtempSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {beforeEach, describe, expect, it} from 'vitest'
import {total} from '#shared/roadmap'
import {DEFAULT_CHUNK_PROMPT, DEFAULT_FOCUS_PROMPT} from '#shared/prompt'
import {backup, restoreBackup} from '../server/utils/backup'
import {openDb} from '../server/utils/db'
import {readRoadmap} from '../server/utils/roadmap'
import {Store} from '../server/utils/store'
import type {Actor} from '../server/utils/store'

let store: Store
let changes: string[]

beforeEach(() => {
    changes = []
    store = new Store(openDb(':memory:'), project => changes.push(project))
    store.createProject({name: 'larder', key: 'LAR'})
    store.createChunk('larder', {title: 'Moving parts: joints'})
})

/** The status code and message a call fails with. */
function failure(call: () => unknown): {status: number, message: string} {
    try {
        call()
    } catch (error) {
        const {statusCode, message} = error as {statusCode: number, message: string}
        return {status: statusCode, message}
    }
    throw new Error('it did not fail')
}

describe('projects', () => {
    it('makes an id and key from the name', () => {
        const project = store.createProject({name: 'Fitness App'})
        expect([project.id, project.key]).toEqual(['fitness-app', 'FIT'])
        expect(failure(() => store.createProject({name: 'fitness app'})).status).toBe(409)
    })

    it('refuses unknown fields', () => {
        expect(failure(() => store.createProject({name: 'x', colour: 'red'})))
            .toEqual({status: 400, message: 'unknown field "colour"; this takes id, name, key, description, icon, iconColor, focusPrompt, chunkPrompt, instructions, muted'})
    })

    it('keep an icon to set and clear', () => {
        expect(store.updateProject('larder', {icon: 'shopping-cart'}).icon).toBe('shopping-cart')
        expect(failure(() => store.updateProject('larder', {icon: 'Cart Icon'})).status).toBe(400)
        expect(store.updateProject('larder', {icon: null}).icon).toBeUndefined()
    })

    it("keep an icon colour, a tint's name or a #rrggbb", () => {
        expect(store.updateProject('larder', {iconColor: 'teal'}).iconColor).toBe('teal')
        expect(store.updateProject('larder', {iconColor: '#123abc'}).iconColor).toBe('#123abc')
        expect(failure(() => store.updateProject('larder', {iconColor: 'red; background: url(x)'})).status).toBe(400)
        expect(store.updateProject('larder', {iconColor: null}).iconColor).toBeUndefined()
    })

    it('deletes everything in it', () => {
        const issue = store.createIssue('larder', {title: 'A'})
        store.createComment('larder', issue.id, {body: 'hi'})
        store.deleteProject('larder')
        expect(store.listProjects()).toEqual([])
        expect(store.db.prepare('SELECT count(*) AS n FROM comments').get()).toEqual({n: 0})
    })
})

describe('issues', () => {
    const add = (body: Record<string, unknown>, actor?: Actor) => store.createIssue('larder', body, actor).id

    it('get the project prefix and the next number, and land in a column', () => {
        const a = store.createIssue('larder', {title: 'Joint editor', chunk: '1', status: 'todo', priority: 'P1'})
        const b = store.createIssue('larder', {title: 'Unplanned'})
        expect([a.id, a.column, a.chunk]).toEqual(['LAR-1', 'todo', '1'])
        expect([b.id, b.column, b.chunk]).toEqual(['LAR-2', 'backlog', null])
        expect(store.project('larder').board.chunks.map(c => c.title)).toEqual(['Moving parts: joints', 'No chunk'])
        expect(changes.at(-1)).toBe('larder')
    })

    it("can't be given an id", () => {
        expect(failure(() => store.createIssue('larder', {id: 'MOT-5', title: 'x'})).message).toMatch(/^unknown field "id"/)
        expect(failure(() => store.createChunk('larder', {id: 'joints', title: 'x'})).message).toMatch(/^unknown field "id"/)
    })

    it('nest in their parent and its chunk', () => {
        const parent = add({title: 'Joints', chunk: '1', status: 'todo'})
        const hinge = add({title: 'Hinge', parent, status: 'in-progress'})
        const slider = add({title: 'Slider', parent, status: 'done'})

        const shown = store.issue('larder', parent)
        expect(shown.column).toBe('in-progress')
        expect(shown.tasks.map(t => t.id)).toEqual([hinge, slider])
        expect([shown.kinds.done, total(shown.kinds)]).toEqual([1, 2])
        expect(store.issue('larder', hinge)).toMatchObject({parent, chunk: '1'})
        expect(store.listIssues('larder', {parent: 'none'}).map(i => i.id)).toEqual([parent])
        expect(failure(() => add({title: 'x', parent, chunk: '1'})).status).toBe(400)
    })

    it("can't become their own ancestor", () => {
        const a = add({title: 'A'})
        const b = add({title: 'B', parent: a})
        expect(failure(() => store.updateIssue('larder', a, {parent: b})).message).toBe(`${b} is under this issue, so it can't be its parent`)
        expect(failure(() => store.updateIssue('larder', a, {parent: a})).status).toBe(400)
    })

    it('lift into the chunk they were in', () => {
        const a = add({title: 'A', chunk: '1'})
        const b = add({title: 'B', parent: a})
        expect(store.updateIssue('larder', b, {parent: null})).toMatchObject({parent: null, chunk: '1'})
    })

    it('clear fields with null and go with their parent', () => {
        const a = add({title: 'A', priority: 'P1'})
        add({title: 'B', parent: a})
        expect(store.updateIssue('larder', a, {priority: null}).priority).toBeUndefined()
        store.deleteIssue('larder', a)
        expect(store.listIssues('larder')).toEqual([])
    })

    it('keep an assignee and labels, and filter by them', () => {
        const a = add({title: 'A', assignee: 'claude', labels: ['bug', 'ui', 'bug']})
        const b = add({title: 'B'})
        expect(store.issue('larder', a)).toMatchObject({assignee: 'claude', labels: ['bug', 'ui']})
        expect(store.listIssues('larder', {label: 'ui'}).map(i => i.id)).toEqual([a])
        expect(store.listIssues('larder', {assignee: 'none'}).map(i => i.id)).toEqual([b])
        expect(store.updateIssue('larder', a, {labels: null, assignee: null})).toMatchObject({labels: [], assignee: undefined})
        expect(failure(() => add({title: 'x', labels: 'bug'})).status).toBe(400)
    })

    it("move to another project with their sub-issues and comments, taking that project's ids", () => {
        store.createProject({name: 'orrery', key: 'ORR'})
        store.createChunk('orrery', {title: 'v1'})
        store.createIssue('orrery', {title: 'already there'})
        const a = add({title: 'A', chunk: '1'})
        const b = add({title: 'B', parent: a})
        store.createComment('larder', b, {body: 'hi'})

        const moved = store.updateIssue('larder', a, {project: 'orrery', chunk: '1', priority: 'P2'})
        expect(moved).toMatchObject({id: 'ORR-2', project: 'orrery', chunk: '1', parent: null, priority: 'P2', aliases: ['LAR-1']})
        expect(moved.tasks.map(t => t.id)).toEqual(['ORR-3'])
        expect(store.listComments('orrery', b).map(c => c.body)).toEqual(['hi'])
        expect(store.issue('orrery', 'LAR-1').id).toBe('ORR-2')
        expect(store.listIssues('larder')).toEqual([])
        expect(changes.slice(-3)).toEqual(['larder', 'orrery', 'orrery'])
    })

    it('stay when their chunk is deleted', () => {
        const a = add({title: 'A', chunk: '1'})
        store.deleteChunk('larder', '1')
        expect(store.issue('larder', a).chunk).toBeNull()
    })
})

describe('comments', () => {
    it('list, show, update and delete', () => {
        const a = store.createIssue('larder', {title: 'A'}).id
        const comment = store.createComment('larder', a, {body: 'Started on `joints.rs`'}, {name: 'claude', owner: false})
        expect(comment.createdBy).toBe('claude')
        expect(store.issue('larder', a).comments).toBe(1)
        expect(store.updateComment('larder', a, comment.id, {body: 'Done'}).body).toBe('Done')
        expect(store.listComments('larder', a).map(c => c.body)).toEqual(['Done'])
        store.deleteComment('larder', a, comment.id)
        expect(failure(() => store.comment('larder', a, comment.id)).status).toBe(404)
    })
})

describe('activity', () => {
    const owner: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}
    const changed = (issue: string, project = 'larder') => store.listActivity(project, issue).map(e => [e.field, e.before, e.after, e.createdBy])

    it('notes who changed which field, from what to what', () => {
        const {id} = store.createIssue('larder', {title: 'A', notes: 'first'}, owner)
        store.updateIssue('larder', id, {title: 'A', status: 'in-progress', assignee: 'claude', priority: 'P2'}, claude)
        store.updateIssue('larder', id, {notes: 'second', labels: ['ui'], chunk: '1'}, claude)
        store.updateIssue('larder', id, {notes: 'second', priority: null}, owner)
        expect(changed(id)).toEqual([
            ['created', undefined, undefined, 'skoll'],
            ['status', 'backlog', 'in-progress', 'claude'],
            ['priority', undefined, 'P2', 'claude'],
            ['assignee', undefined, 'claude', 'claude'],
            ['labels', '[]', '["ui"]', 'claude'],
            ['notes', undefined, undefined, 'claude'],
            ['chunk', undefined, '1', 'claude'],
            ['priority', 'P2', undefined, 'skoll'],
        ])
        expect(store.listActivity('larder', id)[0]).toMatchObject({issue: id, protected: true})
    })

    it('notes a new parent, not the chunk that comes with it', () => {
        const parent = store.createIssue('larder', {title: 'P', chunk: '1'}).id
        const {id} = store.createIssue('larder', {title: 'A', chunk: '1'})
        store.updateIssue('larder', id, {parent})
        store.updateIssue('larder', id, {parent: null})
        expect(changed(id).slice(1)).toEqual([['parent', undefined, parent, 'agent'], ['parent', parent, undefined, 'agent']])
    })

    it('notes decisions and the assignee an ask hands over', () => {
        const {id} = store.createIssue('larder', {title: 'Button', proposal: 'pending'}, claude)
        store.decide('larder', id, {decision: 'approved'}, owner)
        store.createComment('larder', id, {body: 'Ship it?', asks: 'decision'}, claude)
        expect(changed(id).slice(1)).toEqual([
            ['proposal', 'pending', 'approved', 'skoll'],
            ['assignee', 'owner', 'claude', 'skoll'],
            ['assignee', 'claude', 'owner', 'claude'],
        ])
    })

    it('moves with the issue to another project, and goes when it does', () => {
        store.createProject({name: 'orrery', key: 'ORR'})
        const {id} = store.createIssue('larder', {title: 'A'})
        const moved = store.updateIssue('larder', id, {project: 'orrery'}, owner)
        expect(changed(moved.id, 'orrery')).toEqual([['created', undefined, undefined, 'agent'], ['project', 'larder', 'orrery', 'skoll']])
        store.deleteIssue('orrery', moved.id, owner)
        expect(store.db.prepare('SELECT count(*) AS n FROM issue_events').get()).toEqual({n: 0})
    })
})

describe('proposals', () => {
    const owner: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}

    it('sit in Proposed with their sub-issues, out of the committed work', () => {
        const proposal = store.createIssue('larder', {title: 'Button', proposal: 'pending', chunk: '1'})
        store.createIssue('larder', {title: 'Its states', parent: proposal.id, status: 'todo'})
        store.createIssue('larder', {title: 'Work', chunk: '1', status: 'todo'})
        const {board} = store.project('larder')
        expect([store.issue('larder', proposal.id).column, board.kinds.proposed, total(board.kinds)]).toEqual(['proposed', 1, 1])
        expect(store.listIssues('larder', {proposal: 'none'}).map(i => i.title)).toEqual(['Work'])
    })

    it("are decided by the owner, who's heard by the session on them", () => {
        const {id} = store.createIssue('larder', {title: 'Button', proposal: 'pending'}, claude)
        expect(failure(() => store.decide('larder', id, {decision: 'approved'}, claude)).status).toBe(403)
        const decided = store.decide('larder', id, {decision: 'changes', note: 'Rounder corners'}, owner)
        expect([decided.proposal, decided.decidedBy, decided.decisionNote, decided.column]).toEqual(['changes', 'skoll', 'Rounder corners', 'proposed'])
        expect(store.listComments('larder', id).at(-1)?.body).toBe('Asked for changes to this proposal.\n\nRounder corners')
        // Put up again, it waits on a new decision.
        expect(store.updateIssue('larder', id, {proposal: 'pending'}, claude).decidedBy).toBeUndefined()
        expect(failure(() => store.decide('larder', store.createIssue('larder', {title: 'Work'}).id, {decision: 'approved'}, owner)).status).toBe(400)
    })

    it('are committed once approved, or by the owner', () => {
        const {id} = store.createIssue('larder', {title: 'Button', proposal: 'pending'})
        expect(failure(() => store.updateIssue('larder', id, {proposal: null}, claude)).status).toBe(403)
        store.decide('larder', id, {decision: 'approved'}, owner)
        const committed = store.updateIssue('larder', id, {proposal: null, status: 'todo'}, claude)
        expect([committed.proposal, committed.column, committed.decidedBy]).toEqual([undefined, 'todo', 'skoll'])
        const other = store.createIssue('larder', {title: 'Card', proposal: 'pending'})
        expect(store.updateIssue('larder', other.id, {proposal: null}, owner).column).toBe('backlog')
    })

    it("are the owner's until decided, then back with whoever proposed them", () => {
        const {id} = store.createIssue('larder', {title: 'Button', proposal: 'pending'}, claude)
        expect(store.issue('larder', id).assignee).toBe('owner')
        expect(store.decide('larder', id, {decision: 'changes'}, owner).assignee).toBe('claude')
        expect(store.updateIssue('larder', id, {proposal: 'pending'}, claude).assignee).toBe('owner')
        expect(store.createIssue('larder', {title: 'Card', proposal: 'pending', assignee: 'claude'}, claude).assignee).toBe('claude')
    })
})

describe("the owner's things", () => {
    const me: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}
    const add = (body: Record<string, unknown>, actor: Actor) => store.createIssue('larder', body, actor).id

    it('record who made them', () => {
        expect(store.createIssue('larder', {title: 'A'}, me)).toMatchObject({createdBy: 'skoll', protected: true})
        expect(store.createIssue('larder', {title: 'B'}, claude)).toMatchObject({createdBy: 'claude', protected: false})
    })

    it("can't be deleted by an agent, directly or with what holds them", () => {
        const a = add({title: 'A'}, claude)
        const b = add({title: 'B', parent: a}, me)
        const comment = store.createComment('larder', a, {body: 'mine'}, me)

        expect(failure(() => store.deleteIssue('larder', b, claude))).toEqual({status: 403, message: `Deleting ${b} is the owner's call: ${b} was made by the owner`})
        expect(failure(() => store.deleteIssue('larder', a, claude)).message).toBe(`Deleting ${a} is the owner's call: ${b}, comment ${comment.id} on ${a} were made by the owner`)
        expect(failure(() => store.deleteComment('larder', a, comment.id, claude)).status).toBe(403)
        expect(failure(() => store.updateComment('larder', a, comment.id, {body: 'not yours'}, claude)).status).toBe(403)
        expect(failure(() => store.deleteProject('larder', claude)).status).toBe(403)
        expect(failure(() => store.importRoadmap('larder', {comment: '', chunks: []}, true, claude)).status).toBe(403)

        store.deleteIssue('larder', a, me)
        expect(store.listIssues('larder')).toEqual([])
    })

    it('leave what agents made deletable', () => {
        const a = add({title: 'A'}, claude)
        store.deleteIssue('larder', a, {name: 'codex', owner: false})
        expect(store.listIssues('larder')).toEqual([])
    })
})

describe("the owner's name", () => {
    const owner: Actor = {name: 'owner', owner: true}
    const claude: Actor = {name: 'claude', owner: false}

    it("is unset until it's given, with the id it had before", () => {
        expect(store.ownerOf()).toEqual({name: 'owner', display: 'owner', named: false})
    })

    it('makes a lowercase snake-case id, and moves what was theirs to it', () => {
        const mine = store.createIssue('larder', {title: 'Mine'}, owner)
        const proposed = store.createIssue('larder', {title: 'A', proposal: 'pending'}, claude)
        expect(store.issue('larder', proposed.id).assignee).toBe('owner')

        expect(store.nameOwner({name: 'Sköll Fenrisson'}, claude)).toEqual({name: 'skoll_fenrisson', display: 'Sköll Fenrisson', named: true})
        expect(store.issue('larder', mine.id).createdBy).toBe('skoll_fenrisson')
        expect(store.issue('larder', proposed.id).assignee).toBe('skoll_fenrisson')
        expect(store.issue('larder', mine.id).protected).toBe(true)
    })

    it('is who `owner` means as an assignee, so agents needn\'t know the id', () => {
        store.nameOwner({name: 'Sköll Fenrisson'})
        const a = store.createIssue('larder', {title: 'A', assignee: 'owner'}, claude)
        expect(a.assignee).toBe('skoll_fenrisson')
        const b = store.createIssue('larder', {title: 'B'}, claude)
        expect(store.updateIssue('larder', b.id, {assignee: 'Owner'}, claude).assignee).toBe('skoll_fenrisson')
        expect(store.listIssues('larder', {assignee: 'owner'}).map(i => i.id)).toEqual([a.id, b.id])
        expect(store.updateIssue('larder', b.id, {assignee: 'claude'}, claude).assignee).toBe('claude')
    })

    it('is only the owner\'s to change once given', () => {
        store.nameOwner({name: 'Skoll'})
        expect(failure(() => store.nameOwner({name: 'Hati'}, claude)).status).toBe(403)
        expect(store.nameOwner({name: 'Hati'}, {name: 'skoll', owner: true}).name).toBe('hati')
    })

    it('needs a letter or a digit, and not the name requests without one get', () => {
        expect(failure(() => store.nameOwner({name: '!!'})).status).toBe(400)
        expect(failure(() => store.nameOwner({name: 'Agent'})).status).toBe(400)
    })
})

describe("the owner's comments", () => {
    it('go to the session last asked to focus on the issue, or to all', () => {
        const sent: string[] = []
        const local = new Store(openDb(':memory:'), () => {}, signal => sent.push(`${signal.kind}:${signal.target ?? 'all'}:${signal.note}`))
        local.createProject({name: 'larder', key: 'LAR'})
        const me = {name: 'skoll', owner: true}
        const {id} = local.createIssue('larder', {title: 'A'})
        local.createComment('larder', id, {body: 'first'}, me)
        local.focus('larder', id, {session: 'joints-window'}, me)
        local.createComment('larder', id, {body: 'second'}, me)
        local.createComment('larder', id, {body: 'from an agent'}, {name: 'claude', owner: false})
        expect(sent).toEqual(['comment:all:first', 'focus:joints-window:undefined', 'comment:joints-window:second'])
    })
})

describe('chunks', () => {
    it('have a priority to set and clear', () => {
        expect(store.chunk('larder', '1').priority).toBeUndefined()
        expect(store.updateChunk('larder', '1', {priority: 'P1'}).priority).toBe('P1')
        expect(store.project('larder').board.chunks[0]!.priority).toBe('P1')
        expect(store.updateChunk('larder', '1', {priority: null}).priority).toBeUndefined()
        expect(failure(() => store.updateChunk('larder', '1', {priority: 'P7'})).status).toBe(400)
    })

    it('can be focused on, by their id or a name they had', () => {
        const sent: string[] = []
        const local = new Store(openDb(':memory:'), () => {}, signal => sent.push(`${signal.kind}:${signal.issue ?? '-'}:${signal.chunk}:${signal.target ?? 'all'}`))
        local.createProject({name: 'larder', key: 'LAR'})
        local.createChunk('larder', {title: 'Joints'})
        const signal = local.focusChunk('larder', '1', {session: 'joints-window', note: 'urgent'}, {name: 'skoll', owner: true})
        expect(signal).toMatchObject({chunk: '1', kind: 'focus', note: 'urgent', protected: true})
        expect(signal.issue).toBeUndefined()
        expect(sent).toEqual(['focus:-:1:joints-window'])
        expect(local.listSignals('larder', 0, 50, {chunk: '1'}).map(s => s.id)).toEqual([signal.id])
        expect(failure(() => local.focusChunk('larder', '9', {})).status).toBe(404)
        expect(local.focusChunk('larder', 'none', {}).chunk).toBe('none')
    })

    it('can be focused on for their issues of one status', () => {
        const local = new Store(openDb(':memory:'), () => {})
        local.createProject({name: 'larder', key: 'LAR'})
        local.createChunk('larder', {title: 'Joints'})
        expect(local.focusChunk('larder', '1', {status: 'todo'}, {name: 'skoll', owner: true}).status).toBe('todo')
        expect(local.focusChunk('larder', '1', {}).status).toBeUndefined()
        expect(failure(() => local.focusChunk('larder', '1', {status: 'done'})).status).toBe(400)
        expect(failure(() => local.focusChunk('larder', '1', {status: 'soon'})).status).toBe(400)
    })
})

describe('what sessions are told', () => {
    const owner: Actor = {name: 'skoll', owner: true}

    it("uses the project's templates, else the Orrery's, else the defaults", () => {
        expect(store.prompts('larder')).toEqual({focus: DEFAULT_FOCUS_PROMPT, chunk: DEFAULT_CHUNK_PROMPT})
        store.updateSettings({focusPrompt: 'Look at {issue}.'}, owner)
        store.updateProject('larder', {chunkPrompt: 'Do chunk {chunk}.'}, owner)
        expect(store.prompts('larder')).toEqual({focus: 'Look at {issue}.', chunk: 'Do chunk {chunk}.'})
        store.updateProject('larder', {chunkPrompt: '  '}, owner)
        store.updateSettings({focusPrompt: ''}, owner)
        expect(store.prompts('larder')).toEqual({focus: DEFAULT_FOCUS_PROMPT, chunk: DEFAULT_CHUNK_PROMPT})
    })

    it("are the owner's to change", () => {
        expect(failure(() => store.updateProject('larder', {focusPrompt: 'x'}, {name: 'claude', owner: false})).status).toBe(403)
        expect(failure(() => store.updateSettings({instructions: []}, {name: 'claude', owner: false})).status).toBe(403)
        expect(store.updateProject('larder', {description: 'still fine'}).description).toBe('still fine')
    })

    it('add the standing instructions ticked by default, or those picked for the send', () => {
        const {instructions: [commit, branch]} = store.updateSettings({instructions: [{text: 'Commit whenever a piece works'}, {text: 'Make a branch', on: false}]}, owner)
        expect([commit!.on, branch!.on, commit!.id]).toEqual([true, false, expect.stringMatching(/^[0-9a-f]{8}$/)])
        const {instructions: [tests]} = store.updateProject('larder', {instructions: [{text: 'Run the tests'}]}, owner)
        const {id} = store.createIssue('larder', {title: 'A'})
        expect(store.focus('larder', id, {}, owner).instructions).toEqual(['Commit whenever a piece works', 'Run the tests'])
        store.updateProject('larder', {muted: [commit!.id]}, owner)
        expect(store.focus('larder', id, {}, owner).instructions).toEqual(['Run the tests'])
        expect(store.focusChunk('larder', '1', {instructions: [branch!.id, tests!.id]}, owner).instructions).toEqual(['Make a branch', 'Run the tests'])
        expect(store.focus('larder', id, {instructions: []}, owner).instructions).toEqual([])
        expect(failure(() => store.focus('larder', id, {instructions: ['nope']}, owner)).status).toBe(400)
        expect(failure(() => store.updateSettings({instructions: [{text: ''}]}, owner)).status).toBe(400)
    })
})

describe('the bell', () => {
    it("clears agents' comments by id or up to a time, leaving them on their issues", () => {
        const {id} = store.createIssue('larder', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        const first = store.createComment('larder', id, {body: 'one'}, agent)
        store.createComment('larder', id, {body: 'two'}, agent)
        store.createComment('larder', id, {body: 'mine'}, {name: 'skoll', owner: true})
        expect(store.clearNotices({ids: [first.id]})).toBe(1)
        expect(store.notices().map(n => n.body)).toEqual(['two'])
        expect(store.clearNotices({before: new Date(Date.now() + 1000).toISOString()})).toBe(1)
        expect(store.notices()).toEqual([])
        expect(store.listComments('larder', id)).toHaveLength(3)
        expect(failure(() => store.clearNotices({})).status).toBe(400)
    })
})

describe('comments that wait on the owner', () => {
    it('lead the bell until the owner answers, and survive Clear read', () => {
        const {id} = store.createIssue('larder', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        store.createComment('larder', id, {body: 'note'}, agent)
        const ask = store.createComment('larder', id, {body: 'Ship it?', asks: 'decision'}, agent)
        store.createComment('larder', id, {body: 'later note'}, agent)
        expect(ask).toMatchObject({asks: 'decision'})
        expect(store.notices().map(n => [n.body, n.answered])).toEqual([['Ship it?', false], ['later note', undefined], ['note', undefined]])
        store.clearNotices({before: new Date(Date.now() + 1000).toISOString()})
        expect(store.notices().map(n => n.body)).toEqual(['Ship it?'])
        store.createComment('larder', id, {body: 'Yes'}, {name: 'skoll', owner: true})
        expect(store.notices()[0]).toMatchObject({body: 'Ship it?', answered: true})
        expect(store.listComments('larder', id).find(c => c.id === ask.id)).toMatchObject({asks: 'decision', answered: true})
        expect(failure(() => store.createComment('larder', id, {body: 'x', asks: 'vibes'}, agent)).status).toBe(400)
    })

    it("make the issue the owner's until they answer, then the asker's again", () => {
        const {id} = store.createIssue('larder', {title: 'A', assignee: 'claude'})
        const agent = {name: 'claude', owner: false}
        const skoll = {name: 'skoll', owner: true}
        store.createComment('larder', id, {body: 'note'}, agent)
        expect(store.issue('larder', id).assignee).toBe('claude')
        store.createComment('larder', id, {body: 'Ship it?', asks: 'decision'}, agent)
        expect(store.issue('larder', id).assignee).toBe('owner')
        store.createComment('larder', id, {body: 'Yes'}, skoll)
        expect(store.issue('larder', id).assignee).toBe('claude')
        // Answered already, so a later word from the owner leaves it with the agent.
        store.updateIssue('larder', id, {assignee: 'owner'}, skoll)
        store.createComment('larder', id, {body: 'Mine now'}, skoll)
        expect(store.issue('larder', id).assignee).toBe('owner')
    })
})

describe('statuses', () => {
    const owner = {name: 'skoll', owner: true}

    it('start as Backlog, Todo, In progress, In review, Done and Canceled, in board order', () => {
        expect(store.statuses().map(s => `${s.id}:${s.kind}`)).toEqual(['backlog:backlog', 'todo:todo', 'in-progress:started', 'in-review:started', 'done:done', 'canceled:canceled'])
        expect(store.settings().statuses).toHaveLength(6)
    })

    it('take an id, a kind, or the words from before statuses', () => {
        const status = (body: Record<string, unknown>) => store.createIssue('larder', {title: 'x', ...body}).status
        expect(status({status: 'in-review'})).toBe('in-review')
        expect(status({status: 'started'})).toBe('in-progress')
        expect(status({status: 'doing'})).toBe('in-progress')
        expect(status({status: 'todo', plan: 'next'})).toBe('todo')
        expect(status({status: 'todo', plan: null})).toBe('backlog')
        expect(status({plan: 'now'})).toBe('todo')
        expect(status({})).toBe('backlog')
        expect(failure(() => status({status: 'soon'})).status).toBe(400)
        const a = store.createIssue('larder', {title: 'A', status: 'todo'}).id
        expect(store.updateIssue('larder', a, {status: 'canceled'}).kind).toBe('canceled')
        expect(store.listIssues('larder', {status: 'started'}).map(i => i.status)).toEqual(['in-review', 'in-progress', 'in-progress'])
        expect(store.listIssues('larder', {column: 'canceled'}).map(i => i.id)).toEqual([a])
    })

    it("are the owner's to add, change and remove, keeping one of each kind", () => {
        const claude = {name: 'claude', owner: false}
        expect(failure(() => store.createStatus({name: 'Blocked', kind: 'started'}, claude)).status).toBe(403)
        const blocked = store.createStatus({name: 'Blocked', kind: 'started', color: 'rose'}, owner)
        expect(blocked).toMatchObject({id: 'blocked', name: 'Blocked', kind: 'started', color: 'rose'})
        expect(store.statuses().map(s => s.id)).toEqual(['backlog', 'todo', 'in-progress', 'in-review', 'blocked', 'done', 'canceled'])
        expect(failure(() => store.createStatus({name: 'Blocked', kind: 'started'}, owner)).status).toBe(409)
        expect(failure(() => store.createStatus({name: 'Proposed', kind: 'todo'}, owner)).status).toBe(400)
        expect(store.updateStatus('blocked', {name: 'Stuck', color: '#ff0000'}, owner)).toMatchObject({id: 'blocked', name: 'Stuck', color: '#ff0000'})
        expect(failure(() => store.updateStatus('todo', {kind: 'started'}, owner)).status).toBe(409)

        const id = store.createIssue('larder', {title: 'Stuck', status: 'blocked'}).id
        expect(failure(() => store.deleteStatus('blocked', undefined, owner)).status).toBe(409)
        store.deleteStatus('blocked', 'in-progress', owner)
        expect(store.issue('larder', id).status).toBe('in-progress')
        expect(failure(() => store.deleteStatus('todo', 'backlog', owner)).status).toBe(409)
        expect(failure(() => store.status('blocked')).status).toBe(404)
    })

    it('narrow a chunk focus to an open one, by id or kind', () => {
        const signal = (status: string) => store.focusChunk('larder', '1', {status}, owner).status
        expect(signal('in-review')).toBe('in-review')
        expect(signal('started')).toBe('started')
        expect(failure(() => signal('done')).status).toBe(400)
        expect(failure(() => signal('canceled')).status).toBe(400)
    })
})

describe('settings', () => {
    it('keep a tint, the owner’s to change', () => {
        expect(store.settings().tint).toBeNull()
        expect(store.updateSettings({tint: 'blue'}, {name: 'skoll', owner: true}).tint).toBe('blue')
        expect(store.updateSettings({tint: '#123abc'}, {name: 'skoll', owner: true}).tint).toBe('#123abc')
        expect(failure(() => store.updateSettings({tint: 'red; background: url(x)'}, {name: 'skoll', owner: true})).status).toBe(400)
        expect(failure(() => store.updateSettings({tint: null}, {name: 'claude', owner: false})).status).toBe(403)
        expect(store.updateSettings({tint: null}, {name: 'skoll', owner: true}).tint).toBeNull()
    })
})

describe('removing', () => {
    it('an issue takes its signals with it', () => {
        const {id} = store.createIssue('larder', {title: 'A'})
        store.focus('larder', id, {}, {name: 'skoll', owner: true})
        store.deleteIssue('larder', id, {name: 'skoll', owner: true})
        expect(store.listSignals('larder')).toEqual([])
    })
})

describe('a session that connects', () => {
    it("gets the owner's comments that no agent has answered", () => {
        const sent: string[] = []
        const local = new Store(openDb(':memory:'), () => {}, signal => sent.push(`${signal.issue}:${signal.target}:${signal.note}`))
        local.createProject({name: 'larder', key: 'LAR'})
        const me = {name: 'skoll', owner: true}
        const a = local.createIssue('larder', {title: 'A'}).id
        const b = local.createIssue('larder', {title: 'B'}).id
        local.createComment('larder', a, {body: 'answer me'}, me)
        local.createComment('larder', b, {body: 'answered'}, me)
        local.createComment('larder', b, {body: 'here you go'}, {name: 'claude', owner: false})
        sent.length = 0
        expect(local.carryUnanswered('larder', 'new-window')).toBe(1)
        expect(sent).toEqual([`${a}:new-window:answer me`])
    })
})

describe('docs', () => {
    it('are listed with the project, without their text', () => {
        const doc = store.createDoc('larder', {title: 'How joints work', body: '# Joints\n\nA **hinge** turns.'})
        expect(doc).toMatchObject({id: 'how-joints-work', createdBy: 'agent', protected: false})
        expect(store.project('larder').docs.map(d => d.id)).toEqual(['how-joints-work'])
        expect(store.project('larder').docs[0]).not.toHaveProperty('body')
        expect(store.doc('larder', doc.id).body).toContain('**hinge**')
    })

    it('are created or replaced at their id with PUT', () => {
        expect(store.putDoc('larder', 'readme', {title: 'Readme', body: 'one'}).created).toBe(true)
        const {doc, created} = store.putDoc('larder', 'readme', {title: 'README', body: 'two'})
        expect([created, doc.title, doc.body]).toEqual([false, 'README', 'two'])
        expect(failure(() => store.putDoc('larder', 'Bad Id', {title: 'x'})).status).toBe(400)
    })

    it("are the owner's to delete when the owner wrote them", () => {
        store.createDoc('larder', {id: 'mine', title: 'Mine'}, {name: 'skoll', owner: true})
        expect(failure(() => store.deleteDoc('larder', 'mine')).status).toBe(403)
        expect(failure(() => store.deleteProject('larder')).status).toBe(403)
        store.deleteDoc('larder', 'mine', {name: 'skoll', owner: true})
        expect(store.listDocs('larder')).toEqual([])
    })
})

describe('the database', () => {
    it('keeps its data through the migrations and gives it project ids, the old ones as aliases', () => {
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

        const upgraded = new Store(openDb(path))
        const {board} = upgraded.project('larder')
        expect(board.chunks.map(c => [c.id, c.title, c.aliases])).toEqual([['1', 'Joints', ['joints']], ['2', 'UX', ['ux']]])
        // LAR-1 was already the project's kind of id, so it keeps it; the others take the next numbers.
        expect(board.chunks[0]!.tasks.map(t => [t.id, t.aliases, t.tasks.map(s => s.id)])).toEqual([['LAR-2', ['MOT-5'], ['LAR-1']]])
        expect(board.chunks[1]!.tasks.map(t => [t.id, t.aliases])).toEqual([['LAR-3', ['UX-1']]])
        expect(upgraded.issue('larder', 'MOT-5').id).toBe('LAR-2')
        expect(upgraded.listComments('larder', 'MOT-5').map(c => c.body)).toEqual(['hi'])
        expect(upgraded.chunk('larder', 'joints').id).toBe('1')
        expect(upgraded.createIssue('larder', {title: 'new', chunk: 'ux'})).toMatchObject({id: 'LAR-4', chunk: '2'})
        expect(upgraded.createChunk('larder', {title: 'Print'}).id).toBe('3')
        expect(upgraded.updateIssue('larder', 'LAR-4', {priority: 'P0'}).priority).toBe('P0')
    })

    it('is backed up to a folder and restored from it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
        const {id} = store.createIssue('larder', {title: 'saved'})
        backup(store.db, join(dir, 'cloud'))

        const fresh = join(dir, 'new', 'orrery.db')
        restoreBackup(fresh, join(dir, 'cloud'))
        expect(new Store(openDb(fresh)).issue('larder', id).title).toBe('saved')
    })
})

describe('import', () => {
    const roadmap = readRoadmap(readFileSync(new URL('./fixtures/larder-roadmap.json', import.meta.url), 'utf8'))

    it("loads larder's roadmap", () => {
        expect(failure(() => store.importRoadmap('larder', roadmap)).status).toBe(409)
        const {board} = store.importRoadmap('larder', roadmap, true)
        expect(board.chunks).toHaveLength(16)
        expect(total(board.kinds)).toBe(139)
        expect(board.chunks.map(c => c.id)).toEqual(Array.from({length: 16}, (_, i) => String(i + 1)))
        expect(board.chunks[0]!.tasks[0]).toMatchObject({id: 'LAR-1', aliases: ['FIX-1']})
        expect(store.issue('larder', 'MOT-5').aliases).toEqual(['MOT-5'])
        expect(store.createIssue('larder', {title: 'next'}).id).toBe('LAR-140')
    })
})
