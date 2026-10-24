import {mkdtempSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {beforeEach, describe, expect, it} from 'vitest'
import {total} from '#shared/roadmap'
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
    store.createProject({name: 'mesher', key: 'MSH'})
    store.createChunk('mesher', {title: 'Moving parts: joints'})
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
            .toEqual({status: 400, message: 'unknown field "colour"; this takes id, name, key, description'})
    })

    it('deletes everything in it', () => {
        const issue = store.createIssue('mesher', {title: 'A'})
        store.createComment('mesher', issue.id, {body: 'hi'})
        store.deleteProject('mesher')
        expect(store.listProjects()).toEqual([])
        expect(store.db.prepare('SELECT count(*) AS n FROM comments').get()).toEqual({n: 0})
    })
})

describe('issues', () => {
    const add = (body: Record<string, unknown>, actor?: Actor) => store.createIssue('mesher', body, actor).id

    it('get the project prefix and the next number, and land in a column', () => {
        const a = store.createIssue('mesher', {title: 'Joint editor', chunk: '1', plan: 'now', priority: 'P1'})
        const b = store.createIssue('mesher', {title: 'Unplanned'})
        expect([a.id, a.column, a.chunk]).toEqual(['MSH-1', 'now', '1'])
        expect([b.id, b.column, b.chunk]).toEqual(['MSH-2', 'backlog', null])
        expect(store.project('mesher').board.chunks.map(c => c.title)).toEqual(['Moving parts: joints', 'No chunk'])
        expect(changes.at(-1)).toBe('mesher')
    })

    it("can't be given an id", () => {
        expect(failure(() => store.createIssue('mesher', {id: 'MOT-5', title: 'x'})).message).toMatch(/^unknown field "id"/)
        expect(failure(() => store.createChunk('mesher', {id: 'joints', title: 'x'})).message).toMatch(/^unknown field "id"/)
    })

    it('nest in their parent and its chunk', () => {
        const parent = add({title: 'Joints', chunk: '1', plan: 'later'})
        const hinge = add({title: 'Hinge', parent, status: 'doing'})
        const slider = add({title: 'Slider', parent, status: 'done'})

        const shown = store.issue('mesher', parent)
        expect(shown.column).toBe('doing')
        expect(shown.tasks.map(t => t.id)).toEqual([hinge, slider])
        expect([shown.counts.done, total(shown.counts)]).toEqual([1, 2])
        expect(store.issue('mesher', hinge)).toMatchObject({parent, chunk: '1'})
        expect(store.listIssues('mesher', {parent: 'none'}).map(i => i.id)).toEqual([parent])
        expect(failure(() => add({title: 'x', parent, chunk: '1'})).status).toBe(400)
    })

    it("can't become their own ancestor", () => {
        const a = add({title: 'A'})
        const b = add({title: 'B', parent: a})
        expect(failure(() => store.updateIssue('mesher', a, {parent: b})).message).toBe(`${b} is under this issue, so it can't be its parent`)
        expect(failure(() => store.updateIssue('mesher', a, {parent: a})).status).toBe(400)
    })

    it('lift into the chunk they were in', () => {
        const a = add({title: 'A', chunk: '1'})
        const b = add({title: 'B', parent: a})
        expect(store.updateIssue('mesher', b, {parent: null})).toMatchObject({parent: null, chunk: '1'})
    })

    it('clear fields with null and go with their parent', () => {
        const a = add({title: 'A', plan: 'now'})
        add({title: 'B', parent: a})
        expect(store.updateIssue('mesher', a, {plan: null}).plan).toBeUndefined()
        store.deleteIssue('mesher', a)
        expect(store.listIssues('mesher')).toEqual([])
    })

    it('keep an assignee and labels, and filter by them', () => {
        const a = add({title: 'A', assignee: 'claude', labels: ['bug', 'ui', 'bug']})
        const b = add({title: 'B'})
        expect(store.issue('mesher', a)).toMatchObject({assignee: 'claude', labels: ['bug', 'ui']})
        expect(store.listIssues('mesher', {label: 'ui'}).map(i => i.id)).toEqual([a])
        expect(store.listIssues('mesher', {assignee: 'none'}).map(i => i.id)).toEqual([b])
        expect(store.updateIssue('mesher', a, {labels: null, assignee: null})).toMatchObject({labels: [], assignee: undefined})
        expect(failure(() => add({title: 'x', labels: 'bug'})).status).toBe(400)
    })

    it("move to another project with their sub-issues and comments, taking that project's ids", () => {
        store.createProject({name: 'orrery', key: 'ORR'})
        store.createChunk('orrery', {title: 'v1'})
        store.createIssue('orrery', {title: 'already there'})
        const a = add({title: 'A', chunk: '1'})
        const b = add({title: 'B', parent: a})
        store.createComment('mesher', b, {body: 'hi'})

        const moved = store.updateIssue('mesher', a, {project: 'orrery', chunk: '1', priority: 'P2'})
        expect(moved).toMatchObject({id: 'ORR-2', project: 'orrery', chunk: '1', parent: null, priority: 'P2', aliases: ['MSH-1']})
        expect(moved.tasks.map(t => t.id)).toEqual(['ORR-3'])
        expect(store.listComments('orrery', b).map(c => c.body)).toEqual(['hi'])
        expect(store.issue('orrery', 'MSH-1').id).toBe('ORR-2')
        expect(store.listIssues('mesher')).toEqual([])
        expect(changes.slice(-3)).toEqual(['mesher', 'orrery', 'orrery'])
    })

    it('stay when their chunk is deleted', () => {
        const a = add({title: 'A', chunk: '1'})
        store.deleteChunk('mesher', '1')
        expect(store.issue('mesher', a).chunk).toBeNull()
    })
})

describe('comments', () => {
    it('list, show, update and delete', () => {
        const a = store.createIssue('mesher', {title: 'A'}).id
        const comment = store.createComment('mesher', a, {body: 'Started on `joints.rs`'}, {name: 'claude', owner: false})
        expect(comment.createdBy).toBe('claude')
        expect(store.issue('mesher', a).comments).toBe(1)
        expect(store.updateComment('mesher', a, comment.id, {body: 'Done'}).body).toBe('Done')
        expect(store.listComments('mesher', a).map(c => c.body)).toEqual(['Done'])
        store.deleteComment('mesher', a, comment.id)
        expect(failure(() => store.comment('mesher', a, comment.id)).status).toBe(404)
    })
})

describe("the owner's things", () => {
    const me: Actor = {name: 'steffen', owner: true}
    const claude: Actor = {name: 'claude', owner: false}
    const add = (body: Record<string, unknown>, actor: Actor) => store.createIssue('mesher', body, actor).id

    it('record who made them', () => {
        expect(store.createIssue('mesher', {title: 'A'}, me)).toMatchObject({createdBy: 'steffen', protected: true})
        expect(store.createIssue('mesher', {title: 'B'}, claude)).toMatchObject({createdBy: 'claude', protected: false})
    })

    it("can't be deleted by an agent, directly or with what holds them", () => {
        const a = add({title: 'A'}, claude)
        const b = add({title: 'B', parent: a}, me)
        const comment = store.createComment('mesher', a, {body: 'mine'}, me)

        expect(failure(() => store.deleteIssue('mesher', b, claude))).toEqual({status: 403, message: `Deleting ${b} is the owner's call: ${b} was made by the owner`})
        expect(failure(() => store.deleteIssue('mesher', a, claude)).message).toBe(`Deleting ${a} is the owner's call: ${b}, comment ${comment.id} on ${a} were made by the owner`)
        expect(failure(() => store.deleteComment('mesher', a, comment.id, claude)).status).toBe(403)
        expect(failure(() => store.updateComment('mesher', a, comment.id, {body: 'not yours'}, claude)).status).toBe(403)
        expect(failure(() => store.deleteProject('mesher', claude)).status).toBe(403)
        expect(failure(() => store.importRoadmap('mesher', {comment: '', chunks: []}, true, claude)).status).toBe(403)

        store.deleteIssue('mesher', a, me)
        expect(store.listIssues('mesher')).toEqual([])
    })

    it('leave what agents made deletable', () => {
        const a = add({title: 'A'}, claude)
        store.deleteIssue('mesher', a, {name: 'codex', owner: false})
        expect(store.listIssues('mesher')).toEqual([])
    })
})

describe("the owner's comments", () => {
    it('go to the session last asked to focus on the issue, or to all', () => {
        const sent: string[] = []
        const local = new Store(openDb(':memory:'), () => {}, signal => sent.push(`${signal.kind}:${signal.target ?? 'all'}:${signal.note}`))
        local.createProject({name: 'mesher', key: 'MSH'})
        const me = {name: 'steffen', owner: true}
        const {id} = local.createIssue('mesher', {title: 'A'})
        local.createComment('mesher', id, {body: 'first'}, me)
        local.focus('mesher', id, {session: 'joints-window'}, me)
        local.createComment('mesher', id, {body: 'second'}, me)
        local.createComment('mesher', id, {body: 'from an agent'}, {name: 'claude', owner: false})
        expect(sent).toEqual(['comment:all:first', 'focus:joints-window:undefined', 'comment:joints-window:second'])
    })
})

describe('a session that connects', () => {
    it("gets the owner's comments that no agent has answered", () => {
        const sent: string[] = []
        const local = new Store(openDb(':memory:'), () => {}, signal => sent.push(`${signal.issue}:${signal.target}:${signal.note}`))
        local.createProject({name: 'mesher', key: 'MSH'})
        const me = {name: 'steffen', owner: true}
        const a = local.createIssue('mesher', {title: 'A'}).id
        const b = local.createIssue('mesher', {title: 'B'}).id
        local.createComment('mesher', a, {body: 'answer me'}, me)
        local.createComment('mesher', b, {body: 'answered'}, me)
        local.createComment('mesher', b, {body: 'here you go'}, {name: 'claude', owner: false})
        sent.length = 0
        expect(local.carryUnanswered('mesher', 'new-window')).toBe(1)
        expect(sent).toEqual([`${a}:new-window:answer me`])
    })
})

describe('docs', () => {
    it('are listed with the project, without their text', () => {
        const doc = store.createDoc('mesher', {title: 'How joints work', body: '# Joints\n\nA **hinge** turns.'})
        expect(doc).toMatchObject({id: 'how-joints-work', createdBy: 'agent', protected: false})
        expect(store.project('mesher').docs.map(d => d.id)).toEqual(['how-joints-work'])
        expect(store.project('mesher').docs[0]).not.toHaveProperty('body')
        expect(store.doc('mesher', doc.id).body).toContain('**hinge**')
    })

    it('are created or replaced at their id with PUT', () => {
        expect(store.putDoc('mesher', 'readme', {title: 'Readme', body: 'one'}).created).toBe(true)
        const {doc, created} = store.putDoc('mesher', 'readme', {title: 'README', body: 'two'})
        expect([created, doc.title, doc.body]).toEqual([false, 'README', 'two'])
        expect(failure(() => store.putDoc('mesher', 'Bad Id', {title: 'x'})).status).toBe(400)
    })

    it("are the owner's to delete when the owner wrote them", () => {
        store.createDoc('mesher', {id: 'mine', title: 'Mine'}, {name: 'steffen', owner: true})
        expect(failure(() => store.deleteDoc('mesher', 'mine')).status).toBe(403)
        expect(failure(() => store.deleteProject('mesher')).status).toBe(403)
        store.deleteDoc('mesher', 'mine', {name: 'steffen', owner: true})
        expect(store.listDocs('mesher')).toEqual([])
    })
})

describe('the database', () => {
    it('keeps its data through the migrations and gives it project ids, the old ones as aliases', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 2)
        const row = (sql: string) => old.prepare(sql).run()
        row("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('mesher', 'mesher', 'MSH', 'agent', 'x', 'x')")
        row("INSERT INTO chunks (project, id, title, position, created_by, created_at, updated_at) VALUES ('mesher', 'ux', 'UX', 1, 'agent', 'x', 'x')")
        row("INSERT INTO chunks (project, id, title, position, created_by, created_at, updated_at) VALUES ('mesher', 'joints', 'Joints', 0, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, chunk, position, created_by, created_at, updated_at) VALUES ('mesher', 'UX-1', 'ux', 'ux', 0, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, chunk, position, created_by, created_at, updated_at) VALUES ('mesher', 'MOT-5', 'joint', 'joints', 1, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, parent, position, created_by, created_at, updated_at) VALUES ('mesher', 'MSH-1', 'sub', 'MOT-5', 2, 'agent', 'x', 'x')")
        row("INSERT INTO comments (project, issue, body, created_by, created_at, updated_at) VALUES ('mesher', 'MOT-5', 'hi', 'agent', 'x', 'x')")
        old.close()

        const upgraded = new Store(openDb(path))
        const {board} = upgraded.project('mesher')
        expect(board.chunks.map(c => [c.id, c.title, c.aliases])).toEqual([['1', 'Joints', ['joints']], ['2', 'UX', ['ux']]])
        // MSH-1 was already the project's kind of id, so it keeps it; the others take the next numbers.
        expect(board.chunks[0]!.tasks.map(t => [t.id, t.aliases, t.tasks.map(s => s.id)])).toEqual([['MSH-2', ['MOT-5'], ['MSH-1']]])
        expect(board.chunks[1]!.tasks.map(t => [t.id, t.aliases])).toEqual([['MSH-3', ['UX-1']]])
        expect(upgraded.issue('mesher', 'MOT-5').id).toBe('MSH-2')
        expect(upgraded.listComments('mesher', 'MOT-5').map(c => c.body)).toEqual(['hi'])
        expect(upgraded.chunk('mesher', 'joints').id).toBe('1')
        expect(upgraded.createIssue('mesher', {title: 'new', chunk: 'ux'})).toMatchObject({id: 'MSH-4', chunk: '2'})
        expect(upgraded.createChunk('mesher', {title: 'Print'}).id).toBe('3')
        expect(upgraded.updateIssue('mesher', 'MSH-4', {priority: 'P0'}).priority).toBe('P0')
    })

    it('is backed up to a folder and restored from it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
        const {id} = store.createIssue('mesher', {title: 'saved'})
        backup(store.db, join(dir, 'cloud'))

        const fresh = join(dir, 'new', 'orrery.db')
        restoreBackup(fresh, join(dir, 'cloud'))
        expect(new Store(openDb(fresh)).issue('mesher', id).title).toBe('saved')
    })
})

describe('import', () => {
    const roadmap = readRoadmap(readFileSync(new URL('./fixtures/mesher-roadmap.json', import.meta.url), 'utf8'))

    it("loads mesher's roadmap", () => {
        expect(failure(() => store.importRoadmap('mesher', roadmap)).status).toBe(409)
        const {board} = store.importRoadmap('mesher', roadmap, true)
        expect(board.chunks).toHaveLength(16)
        expect(total(board.counts)).toBe(139)
        expect(board.chunks.map(c => c.id)).toEqual(Array.from({length: 16}, (_, i) => String(i + 1)))
        expect(board.chunks[0]!.tasks[0]).toMatchObject({id: 'MSH-1', aliases: ['FIX-1']})
        expect(store.issue('mesher', 'MOT-5').aliases).toEqual(['MOT-5'])
        expect(store.createIssue('mesher', {title: 'next'}).id).toBe('MSH-140')
    })
})
