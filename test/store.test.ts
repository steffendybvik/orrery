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
    it('hands out the next id and lands in a column', () => {
        const a = store.createIssue('mesher', {title: 'Joint editor', chunk: 'moving-parts-joints', plan: 'now', priority: 'P1'})
        const b = store.createIssue('mesher', {title: 'Unplanned'})
        expect([a.id, a.column, a.chunk]).toEqual(['MSH-1', 'now', 'moving-parts-joints'])
        expect([b.id, b.column, b.chunk]).toEqual(['MSH-2', 'backlog', null])
        expect(store.project('mesher').board.chunks.map(c => c.title)).toEqual(['Moving parts: joints', 'No chunk'])
        expect(changes.at(-1)).toBe('mesher')
    })

    it('nests sub-issues in their parent and its chunk', () => {
        const parent = store.createIssue('mesher', {id: 'MOT-5', title: 'Joints', chunk: 'moving-parts-joints', plan: 'later'})
        store.createIssue('mesher', {id: 'MOT-5a', title: 'Hinge', parent: parent.id, status: 'doing'})
        store.createIssue('mesher', {id: 'MOT-5b', title: 'Slider', parent: parent.id, status: 'done'})

        const shown = store.issue('mesher', 'MOT-5')
        expect(shown.column).toBe('doing')
        expect(shown.tasks.map(t => t.id)).toEqual(['MOT-5a', 'MOT-5b'])
        expect([shown.counts.done, total(shown.counts)]).toEqual([1, 2])
        expect(store.issue('mesher', 'MOT-5a')).toMatchObject({parent: 'MOT-5', chunk: 'moving-parts-joints'})
        expect(store.listIssues('mesher', {parent: 'none'}).map(i => i.id)).toEqual(['MOT-5'])
        expect(failure(() => store.createIssue('mesher', {title: 'x', parent: 'MOT-5', chunk: 'moving-parts-joints'})).status).toBe(400)
    })

    it('refuses to make an issue its own ancestor', () => {
        store.createIssue('mesher', {id: 'A', title: 'A'})
        store.createIssue('mesher', {id: 'B', title: 'B', parent: 'A'})
        expect(failure(() => store.updateIssue('mesher', 'A', {parent: 'B'})).message).toBe("B is under this issue, so it can't be its parent")
        expect(failure(() => store.updateIssue('mesher', 'A', {parent: 'A'})).status).toBe(400)
    })

    it('lifts a sub-issue into the chunk it was in', () => {
        store.createIssue('mesher', {id: 'A', title: 'A', chunk: 'moving-parts-joints'})
        store.createIssue('mesher', {id: 'B', title: 'B', parent: 'A'})
        expect(store.updateIssue('mesher', 'B', {parent: null})).toMatchObject({parent: null, chunk: 'moving-parts-joints'})
    })

    it('clears fields with null and deletes sub-issues with their parent', () => {
        store.createIssue('mesher', {id: 'A', title: 'A', plan: 'now'})
        store.createIssue('mesher', {id: 'B', title: 'B', parent: 'A'})
        expect(store.updateIssue('mesher', 'A', {plan: null}).plan).toBeUndefined()
        store.deleteIssue('mesher', 'A')
        expect(store.listIssues('mesher')).toEqual([])
    })

    it('keeps an assignee and labels, and filters by them', () => {
        store.createIssue('mesher', {id: 'A', title: 'A', assignee: 'claude', labels: ['bug', 'ui', 'bug']})
        store.createIssue('mesher', {id: 'B', title: 'B'})
        expect(store.issue('mesher', 'A')).toMatchObject({assignee: 'claude', labels: ['bug', 'ui']})
        expect(store.listIssues('mesher', {label: 'ui'}).map(i => i.id)).toEqual(['A'])
        expect(store.listIssues('mesher', {assignee: 'none'}).map(i => i.id)).toEqual(['B'])
        expect(store.updateIssue('mesher', 'A', {labels: null, assignee: null})).toMatchObject({labels: [], assignee: undefined})
        expect(failure(() => store.createIssue('mesher', {title: 'x', labels: 'bug'})).status).toBe(400)
    })

    it('moves an issue with its sub-issues and comments to another project', () => {
        store.createProject({name: 'orrery'})
        store.createChunk('orrery', {id: 'v1', title: 'v1'})
        store.createIssue('mesher', {id: 'A', title: 'A', chunk: 'moving-parts-joints'})
        store.createIssue('mesher', {id: 'B', title: 'B', parent: 'A'})
        store.createComment('mesher', 'B', {body: 'hi'})

        const moved = store.updateIssue('mesher', 'A', {project: 'orrery', chunk: 'v1', priority: 'P2'})
        expect(moved).toMatchObject({project: 'orrery', chunk: 'v1', parent: null, priority: 'P2'})
        expect(moved.tasks.map(t => t.id)).toEqual(['B'])
        expect(store.listComments('orrery', 'B').map(c => c.body)).toEqual(['hi'])
        expect(store.listIssues('mesher')).toEqual([])
        expect(changes.slice(-3)).toEqual(['mesher', 'orrery', 'orrery'])

        store.createIssue('mesher', {id: 'A', title: 'again'})
        expect(failure(() => store.updateIssue('orrery', 'A', {project: 'mesher'})).status).toBe(409)
    })

    it('keeps the issues of a deleted chunk', () => {
        store.createIssue('mesher', {id: 'A', title: 'A', chunk: 'moving-parts-joints'})
        store.deleteChunk('mesher', 'moving-parts-joints')
        expect(store.issue('mesher', 'A').chunk).toBeNull()
    })
})

describe('comments', () => {
    it('lists, shows, updates and deletes', () => {
        store.createIssue('mesher', {id: 'A', title: 'A'})
        const comment = store.createComment('mesher', 'A', {body: 'Started on `joints.rs`'}, {name: 'claude', owner: false})
        expect(comment.createdBy).toBe('claude')
        expect(store.issue('mesher', 'A').comments).toBe(1)
        expect(store.updateComment('mesher', 'A', comment.id, {body: 'Done'}).body).toBe('Done')
        expect(store.listComments('mesher', 'A').map(c => c.body)).toEqual(['Done'])
        store.deleteComment('mesher', 'A', comment.id)
        expect(failure(() => store.comment('mesher', 'A', comment.id)).status).toBe(404)
    })
})

describe("the owner's things", () => {
    const me: Actor = {name: 'steffen', owner: true}
    const claude: Actor = {name: 'claude', owner: false}

    it('record who made them', () => {
        expect(store.createIssue('mesher', {id: 'A', title: 'A'}, me)).toMatchObject({createdBy: 'steffen', protected: true})
        expect(store.createIssue('mesher', {id: 'B', title: 'B'}, claude)).toMatchObject({createdBy: 'claude', protected: false})
    })

    it("can't be deleted by an agent, directly or with what holds them", () => {
        store.createIssue('mesher', {id: 'A', title: 'A'}, claude)
        store.createIssue('mesher', {id: 'B', title: 'B', parent: 'A'}, me)
        const comment = store.createComment('mesher', 'A', {body: 'mine'}, me)

        expect(failure(() => store.deleteIssue('mesher', 'B', claude))).toEqual({status: 403, message: "Deleting B is the owner's call: B was made by the owner"})
        expect(failure(() => store.deleteIssue('mesher', 'A', claude)).message).toBe(`Deleting A is the owner's call: B, comment ${comment.id} on A were made by the owner`)
        expect(failure(() => store.deleteComment('mesher', 'A', comment.id, claude)).status).toBe(403)
        expect(failure(() => store.updateComment('mesher', 'A', comment.id, {body: 'not yours'}, claude)).status).toBe(403)
        expect(failure(() => store.deleteProject('mesher', claude)).status).toBe(403)
        expect(failure(() => store.importRoadmap('mesher', {comment: '', chunks: []}, true, claude)).status).toBe(403)

        store.deleteIssue('mesher', 'A', me)
        expect(store.listIssues('mesher')).toEqual([])
    })

    it('leave what agents made deletable', () => {
        store.createIssue('mesher', {id: 'A', title: 'A'}, claude)
        store.deleteIssue('mesher', 'A', {name: 'codex', owner: false})
        expect(store.listIssues('mesher')).toEqual([])
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
    it('keeps its data through the migrations and takes P0', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 1)
        old.prepare("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('mesher', 'mesher', 'MES', 'agent', 'x', 'x')").run()
        old.prepare("INSERT INTO issues (project, id, title, position, created_by, created_at, updated_at) VALUES ('mesher', 'A', 'old', 0, 'agent', 'x', 'x')").run()
        old.close()

        const upgraded = new Store(openDb(path))
        expect(upgraded.issue('mesher', 'A').title).toBe('old')
        expect(upgraded.updateIssue('mesher', 'A', {priority: 'P0'}).priority).toBe('P0')
        expect(upgraded.project('mesher').docs).toEqual([])
    })

    it('is backed up to a folder and restored from it', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
        store.createIssue('mesher', {id: 'A', title: 'saved'})
        backup(store.db, join(dir, 'cloud'))

        const fresh = join(dir, 'new', 'orrery.db')
        restoreBackup(fresh, join(dir, 'cloud'))
        expect(new Store(openDb(fresh)).issue('mesher', 'A').title).toBe('saved')
    })
})

describe('import', () => {
    const roadmap = readRoadmap(readFileSync(new URL('./fixtures/mesher-roadmap.json', import.meta.url), 'utf8'))

    it("loads mesher's roadmap", () => {
        expect(failure(() => store.importRoadmap('mesher', roadmap)).status).toBe(409)
        const {board} = store.importRoadmap('mesher', roadmap, true)
        expect(board.chunks).toHaveLength(16)
        expect(total(board.counts)).toBe(139)
    })
})
