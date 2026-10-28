import {mkdtempSync, readFileSync, readdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {beforeEach, describe, expect, it} from 'vitest'
import {total} from '#shared/roadmap'
import {DEFAULT_CHUNK_PROMPT, DEFAULT_FOCUS_PROMPT} from '#shared/prompt'
import {backUp, backupPostgres, lastBackup, restoreBackup} from '../server/utils/backup'
import {openDb} from '../server/utils/db'
import {SqliteDb} from '../server/utils/database'
import {readRoadmap} from '../server/utils/roadmap'
import {Store, UPLOAD_LIMIT} from '../server/utils/store'
import {testDb} from './db'
import type {Actor} from '../server/utils/store'

let store: Store
let changes: string[]

beforeEach(async () => {
    changes = []
    store = new Store(testDb(), project => changes.push(project))
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.createChunk('greenhouse', {title: 'Moving parts: joints'})
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
            .toEqual({status: 400, message: 'unknown field "colour"; this takes id, name, key, description, icon, icon_color, focus_prompt, chunk_prompt, instructions, muted, repo, release_mode, releases_from'})
    })

    it('keep where their code is', async () => {
        expect((await store.updateProject('greenhouse', {repo: 'https://github.com/you/greenhouse'})).repo).toBe('https://github.com/you/greenhouse')
        expect((await failure(() => store.updateProject('greenhouse', {repo: 'github.com/you/greenhouse'}))).status).toBe(400)
        expect((await store.updateProject('greenhouse', {repo: null})).repo).toBeUndefined()
        expect((await store.createProject({name: 'pantry', repo: 'https://git.example/pantry'})).repo).toBe('https://git.example/pantry')
    })

    it('keep an icon to set and clear', async () => {
        expect((await store.updateProject('greenhouse', {icon: 'shopping-cart'})).icon).toBe('shopping-cart')
        expect((await failure(() => store.updateProject('greenhouse', {icon: 'Cart Icon'}))).status).toBe(400)
        expect((await store.updateProject('greenhouse', {icon: null})).icon).toBeUndefined()
    })

    it("keep an icon colour, a tint's name or a #rrggbb", async () => {
        expect((await store.updateProject('greenhouse', {icon_color: 'teal'})).icon_color).toBe('teal')
        expect((await store.updateProject('greenhouse', {icon_color: '#123abc'})).icon_color).toBe('#123abc')
        expect((await failure(() => store.updateProject('greenhouse', {icon_color: 'red; background: url(x)'}))).status).toBe(400)
        expect((await store.updateProject('greenhouse', {icon_color: null})).icon_color).toBeUndefined()
    })

    it('deletes everything in it', async () => {
        const issue = await store.createIssue('greenhouse', {title: 'A'})
        await store.createComment('greenhouse', issue.id, {body: 'hi'})
        await store.deleteProject('greenhouse')
        expect(await store.listProjects()).toEqual([])
        expect(await store.db.get('SELECT count(*) AS n FROM comments')).toEqual({n: 0})
    })
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

describe('comments', () => {
    it('list, show, update and delete', async () => {
        const a = (await store.createIssue('greenhouse', {title: 'A'})).id
        const comment = await store.createComment('greenhouse', a, {body: 'Started on `joints.rs`'}, {name: 'claude', owner: false})
        expect(comment.created_by).toBe('claude')
        expect((await store.issue('greenhouse', a)).comments).toBe(1)
        expect((await store.updateComment('greenhouse', a, comment.id, {body: 'Done'})).body).toBe('Done')
        expect((await store.listComments('greenhouse', a)).map(c => c.body)).toEqual(['Done'])
        await store.deleteComment('greenhouse', a, comment.id)
        expect((await failure(() => store.comment('greenhouse', a, comment.id))).status).toBe(404)
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

describe('proposals', () => {
    const owner: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}

    it('sit in Proposed with their sub-issues, out of the committed work', async () => {
        const proposal = await store.createIssue('greenhouse', {title: 'Button', proposal: 'pending', chunk: '1'})
        await store.createIssue('greenhouse', {title: 'Its states', parent: proposal.id, status: 'todo'})
        await store.createIssue('greenhouse', {title: 'Work', chunk: '1', status: 'todo'})
        const {board} = await store.project('greenhouse')
        expect([(await store.issue('greenhouse', proposal.id)).column, board.kinds.proposed, total(board.kinds)]).toEqual(['proposed', 1, 1])
        expect((await store.listIssues('greenhouse', {proposal: 'none'})).map(i => i.title)).toEqual(['Work'])
    })

    it("are decided by the owner, who's heard by the session on them", async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Button', proposal: 'pending'}, claude)
        expect((await failure(() => store.decide('greenhouse', id, {decision: 'approved'}, claude))).status).toBe(403)
        const decided = await store.decide('greenhouse', id, {decision: 'changes', note: 'Rounder corners'}, owner)
        expect([decided.proposal, decided.decided_by, decided.decision_note, decided.column]).toEqual(['changes', 'skoll', 'Rounder corners', 'proposed'])
        expect((await store.listComments('greenhouse', id)).at(-1)?.body).toBe('Asked for changes to this proposal.\n\nRounder corners')
        // Put up again, it waits on a new decision.
        expect((await store.updateIssue('greenhouse', id, {proposal: 'pending'}, claude)).decided_by).toBeUndefined()
        const work = (await store.createIssue('greenhouse', {title: 'Work'})).id
        expect((await failure(() => store.decide('greenhouse', work, {decision: 'approved'}, owner))).status).toBe(400)
    })

    it('go on the roadmap in Todo when approved, keeping the decision, or are committed by the owner', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Button', proposal: 'pending'})
        expect((await failure(() => store.updateIssue('greenhouse', id, {proposal: null}, claude))).status).toBe(403)
        const approved = await store.decide('greenhouse', id, {decision: 'approved', note: 'Go'}, owner)
        expect([approved.proposal, approved.column, approved.decided_by, approved.decision_note]).toEqual([undefined, 'todo', 'skoll', 'Go'])
        // One whose work went ahead while it waited keeps where it got to.
        const done = await store.createIssue('greenhouse', {title: 'Done already', proposal: 'pending', status: 'done'})
        expect((await store.decide('greenhouse', done.id, {decision: 'approved'}, owner))).toMatchObject({column: 'done', proposal: undefined})
        const started = await store.createIssue('greenhouse', {title: 'Started', proposal: 'pending', status: 'in-progress'})
        expect((await store.decide('greenhouse', started.id, {decision: 'approved'}, owner)).status).toBe('in-progress')
        expect((await store.listComments('greenhouse', id)).at(-1)?.body).toBe('Approved this proposal.\n\nGo')
        const other = await store.createIssue('greenhouse', {title: 'Card', proposal: 'pending'})
        expect((await store.updateIssue('greenhouse', other.id, {proposal: null}, owner)).column).toBe('backlog')
    })

    it("are the owner's until decided, then back with whoever proposed them", async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Button', proposal: 'pending'}, claude)
        expect((await store.issue('greenhouse', id)).assignee).toBe('owner')
        expect((await store.decide('greenhouse', id, {decision: 'changes'}, owner)).assignee).toBe('claude')
        expect((await store.updateIssue('greenhouse', id, {proposal: 'pending'}, claude)).assignee).toBe('owner')
        expect((await store.createIssue('greenhouse', {title: 'Card', proposal: 'pending', assignee: 'claude'}, claude)).assignee).toBe('owner')
        const {id: tag} = await store.createIssue('greenhouse', {title: 'Tag', assignee: 'claude'}, claude)
        expect((await store.updateIssue('greenhouse', tag, {proposal: 'pending', assignee: 'claude'}, claude)).assignee).toBe('owner')
    })

    it("can't be started, assigned or put in a release by an agent while they wait, unless the owner allows it", async () => {
        expect((await store.settings()).restrict_proposals).toBe(true)
        const {id} = await store.createIssue('greenhouse', {title: 'Button', proposal: 'pending'}, claude)
        for (const change of [{status: 'in-progress'}, {plan: 'now'}, {assignee: 'claude'}, {release: '1.0.0'}]) {
            expect((await failure(() => store.updateIssue('greenhouse', id, change, claude))).status).toBe(403)
        }
        // Still open to the agent: its words, and putting it up again after changes.
        expect((await store.updateIssue('greenhouse', id, {notes: 'Rounder', title: 'Round button'}, claude)).title).toBe('Round button')
        await store.decide('greenhouse', id, {decision: 'changes'}, owner)
        expect((await failure(() => store.updateIssue('greenhouse', id, {status: 'in-progress'}, claude))).status).toBe(403)
        expect((await store.updateIssue('greenhouse', id, {proposal: 'pending', assignee: 'claude'}, claude)).proposal).toBe('pending')
        // The owner moves it as they like; with the setting off, so can an agent.
        expect((await store.updateIssue('greenhouse', id, {status: 'in-progress'}, owner)).status).toBe('in-progress')
        expect((await failure(() => store.updateSettings({restrict_proposals: false}, claude))).status).toBe(403)
        await store.updateSettings({restrict_proposals: false}, owner)
        expect((await store.updateIssue('greenhouse', id, {status: 'todo'}, claude)).status).toBe('todo')
        // Approved, it's work like any other.
        await store.updateSettings({restrict_proposals: true}, owner)
        await store.decide('greenhouse', id, {decision: 'approved'}, owner)
        expect((await store.updateIssue('greenhouse', id, {status: 'in-progress'}, claude)).status).toBe('in-progress')
    })
})

describe('proposals with choices', () => {
    const owner: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}
    const PARTS = {key: 'parts', question: 'Which parts?', pick: 'any', recommended: ['A', 'B'],
        options: [{key: 'A', title: 'Write-only store'}, {key: 'B', title: 'orrery makes the call'}, {key: 'D', title: 'Approve risky uses', body: 'Holds the request until you say yes.'}]}
    const KEY = {key: 'key', question: 'Where the key lives', pick: 'one', recommended: ['env'], options: [{key: 'env', title: 'ORRERY_SECRET_KEY'}, {key: 'keychain', title: 'OS keychain'}]}
    const propose = async (choices: object[]) => (await store.createIssue('greenhouse', {title: 'Secrets', proposal: 'pending', choices}, claude)).id

    it('are approved with the recommendation, or with the picks sent', async () => {
        const id = await propose([PARTS, KEY])
        expect((await store.issue('greenhouse', id)).choices.map(c => c.key)).toEqual(['parts', 'key'])
        expect((await store.decide('greenhouse', id, {decision: 'approved'}, owner)).picks).toEqual({parts: ['A', 'B'], key: ['env']})
        expect((await store.listComments('greenhouse', id)).at(-1)?.body)
            .toBe('Approved this proposal with:\n- Which parts? → **A** Write-only store, **B** orrery makes the call\n- Where the key lives → **ORRERY_SECRET_KEY**')
        await store.updateIssue('greenhouse', id, {proposal: 'pending'}, claude)
        expect((await store.issue('greenhouse', id)).picks).toBeUndefined()
        expect((await store.decide('greenhouse', id, {decision: 'approved', picks: {parts: ['A', 'D'], key: ['keychain']}, note: 'D too'}, owner)).picks)
            .toEqual({parts: ['A', 'D'], key: ['keychain']})
    })

    it('refuse picks that make no sense', async () => {
        const id = await propose([PARTS, {...KEY, recommended: []}])
        const refused = async (body: object) => (await failure(() => store.decide('greenhouse', id, body, owner))).status
        expect(await refused({decision: 'approved'})).toBe(400)
        expect(await refused({decision: 'approved', picks: {key: ['env', 'keychain']}})).toBe(400)
        expect(await refused({decision: 'approved', picks: {key: ['vault']}})).toBe(400)
        expect(await refused({decision: 'approved', picks: {colour: ['red'], key: ['env']}})).toBe(400)
        expect(await refused({decision: 'rejected', picks: {key: ['env']}})).toBe(400)
        expect(await refused({decision: 'changes', explore: {choice: 'parts', option: 'Z'}})).toBe(400)
        const bad = async (choices: unknown) => (await failure(() => store.createIssue('greenhouse', {title: 'x', choices}))).status
        expect(await bad([{key: 'k', question: 'q', options: [{key: 'A', title: 'only one'}]}])).toBe(400)
        expect(await bad([{...KEY, recommended: ['env', 'keychain']}])).toBe(400)
        expect(await bad([PARTS, {...KEY, from: {choice: 'parts', option: 'Q'}}])).toBe(400)
    })

    it('go further down an option the owner asks to explore', async () => {
        const id = await propose([PARTS])
        const explored = await store.decide('greenhouse', id, {decision: 'changes', explore: {choice: 'parts', option: 'D'}, note: 'What would a refund look like?'}, owner)
        expect(explored).toMatchObject({proposal: 'changes', explore: {choice: 'parts', option: 'D'}, assignee: 'claude'})
        expect((await store.listComments('greenhouse', id)).at(-1)?.body).toMatch(/^Asked to explore D \(Approve risky uses\) further/)
        const RISK = {key: 'risk', question: 'Which uses wait for you?', pick: 'one', recommended: ['money'], from: {choice: 'parts', option: 'D'},
            options: [{key: 'money', title: 'Anything that spends money'}, {key: 'writes', title: 'Every write'}]}
        await store.updateIssue('greenhouse', id, {choices: [PARTS, RISK], proposal: 'pending'}, claude)
        // Going further down D only counts when D is picked.
        expect((await store.decide('greenhouse', id, {decision: 'approved'}, owner)).picks).toEqual({parts: ['A', 'B']})
        await store.updateIssue('greenhouse', id, {proposal: 'pending'}, claude)
        expect((await store.decide('greenhouse', id, {decision: 'approved', picks: {parts: ['D']}}, owner)).picks).toEqual({parts: ['D'], risk: ['money']})
    })
})

describe("the owner's things", () => {
    const me: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}
    const add = async (body: Record<string, unknown>, actor: Actor) => (await store.createIssue('greenhouse', body, actor)).id

    it('record who made them', async () => {
        expect(await store.createIssue('greenhouse', {title: 'A'}, me)).toMatchObject({created_by: 'skoll', protected: true})
        expect(await store.createIssue('greenhouse', {title: 'B'}, claude)).toMatchObject({created_by: 'claude', protected: false})
    })

    it("can't be deleted by an agent, directly or with what holds them", async () => {
        const a = await add({title: 'A'}, claude)
        const b = await add({title: 'B', parent: a}, me)
        const comment = await store.createComment('greenhouse', a, {body: 'mine'}, me)

        expect(await failure(() => store.deleteIssue('greenhouse', b, claude))).toEqual({status: 403, message: `Deleting ${b} is the owner's call: ${b} was made by the owner`})
        expect((await failure(() => store.deleteIssue('greenhouse', a, claude))).message).toBe(`Deleting ${a} is the owner's call: ${b}, comment ${comment.id} on ${a} were made by the owner`)
        expect((await failure(() => store.deleteComment('greenhouse', a, comment.id, claude))).status).toBe(403)
        expect((await failure(() => store.updateComment('greenhouse', a, comment.id, {body: 'not yours'}, claude))).status).toBe(403)
        expect((await failure(() => store.deleteProject('greenhouse', claude))).status).toBe(403)
        expect((await failure(() => store.importRoadmap('greenhouse', {comment: '', chunks: []}, true, claude))).status).toBe(403)

        await store.deleteIssue('greenhouse', a, me)
        expect(await store.listIssues('greenhouse')).toEqual([])
    })

    it('leave what agents made deletable', async () => {
        const a = await add({title: 'A'}, claude)
        await store.deleteIssue('greenhouse', a, {name: 'codex', owner: false})
        expect(await store.listIssues('greenhouse')).toEqual([])
    })
})

describe("the owner's name", () => {
    const owner: Actor = {name: 'owner', owner: true}
    const claude: Actor = {name: 'claude', owner: false}

    it("is unset until it's given, with the id it had before", async () => {
        expect(await store.ownerOf()).toEqual({name: 'owner', display: 'owner', named: false})
    })

    it('makes a lowercase snake-case id, and moves what was theirs to it', async () => {
        const mine = await store.createIssue('greenhouse', {title: 'Mine'}, owner)
        const proposed = await store.createIssue('greenhouse', {title: 'A', proposal: 'pending'}, claude)
        expect((await store.issue('greenhouse', proposed.id)).assignee).toBe('owner')

        expect(await store.nameOwner({name: 'Sköll Fenrisson'}, claude)).toEqual({name: 'skoll_fenrisson', display: 'Sköll Fenrisson', named: true})
        expect((await store.issue('greenhouse', mine.id)).created_by).toBe('skoll_fenrisson')
        expect((await store.issue('greenhouse', proposed.id)).assignee).toBe('skoll_fenrisson')
        expect((await store.issue('greenhouse', mine.id)).protected).toBe(true)
    })

    it('tells open pages when renamed, with the settings, so they write as the new id', async () => {
        const told: string[] = []
        const local = new Store(testDb(), () => {}, () => {}, () => {}, settings => told.push(settings.id))
        await local.nameOwner({name: 'Skoll'})
        expect(told).toHaveLength(1)
    })

    it('is who `owner` means as an assignee, so agents needn\'t know the id', async () => {
        await store.nameOwner({name: 'Sköll Fenrisson'})
        const a = await store.createIssue('greenhouse', {title: 'A', assignee: 'owner'}, claude)
        expect(a.assignee).toBe('skoll_fenrisson')
        const b = await store.createIssue('greenhouse', {title: 'B'}, claude)
        expect((await store.updateIssue('greenhouse', b.id, {assignee: 'Owner'}, claude)).assignee).toBe('skoll_fenrisson')
        expect((await store.listIssues('greenhouse', {assignee: 'owner'})).map(i => i.id)).toEqual([a.id, b.id])
        expect((await store.updateIssue('greenhouse', b.id, {assignee: 'claude'}, claude)).assignee).toBe('claude')
    })

    it('is only the owner\'s to change once given', async () => {
        await store.nameOwner({name: 'Skoll'})
        expect((await failure(() => store.nameOwner({name: 'Hati'}, claude))).status).toBe(403)
        expect((await store.nameOwner({name: 'Hati'}, {name: 'skoll', owner: true})).name).toBe('hati')
    })

    it('needs a letter or a digit, and not the name requests without one get', async () => {
        expect((await failure(() => store.nameOwner({name: '!!'}))).status).toBe(400)
        expect((await failure(() => store.nameOwner({name: 'Agent'}))).status).toBe(400)
        expect((await failure(() => store.nameOwner({name: 'Claude'}))).status).toBe(400)
    })
})

describe("the owner's comments", () => {
    it('go to the session last asked to focus on the issue, or to all', async () => {
        const sent: string[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(`${signal.kind}:${signal.target ?? 'all'}:${signal.note}`))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const me = {name: 'skoll', owner: true}
        const {id} = await local.createIssue('greenhouse', {title: 'A'})
        await local.createComment('greenhouse', id, {body: 'first'}, me)
        await local.focus('greenhouse', id, {session: 'joints-window'}, me)
        await local.createComment('greenhouse', id, {body: 'second'}, me)
        await local.createComment('greenhouse', id, {body: 'from an agent'}, {name: 'claude', owner: false})
        expect(sent).toEqual(['comment:all:first', 'focus:joints-window:undefined', 'comment:joints-window:second'])
    })
})

describe('chunks', () => {
    it('have a priority to set and clear', async () => {
        expect((await store.chunk('greenhouse', '1')).priority).toBeUndefined()
        expect((await store.updateChunk('greenhouse', '1', {priority: 'P1'})).priority).toBe('P1')
        expect((await store.project('greenhouse')).board.chunks[0]!.priority).toBe('P1')
        expect((await store.updateChunk('greenhouse', '1', {priority: null})).priority).toBeUndefined()
        expect((await failure(() => store.updateChunk('greenhouse', '1', {priority: 'P7'}))).status).toBe(400)
    })

    it('can be focused on, by their id or a name they had', async () => {
        const sent: string[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(`${signal.kind}:${signal.issue ?? '-'}:${signal.chunk}:${signal.target ?? 'all'}`))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        await local.createChunk('greenhouse', {title: 'Joints'})
        const signal = await local.focusChunk('greenhouse', '1', {session: 'joints-window', note: 'urgent'}, {name: 'skoll', owner: true})
        expect(signal).toMatchObject({chunk: '1', kind: 'focus', note: 'urgent', protected: true})
        expect(signal.issue).toBeUndefined()
        expect(sent).toEqual(['focus:-:1:joints-window'])
        expect((await local.listSignals('greenhouse', 0, 50, {chunk: '1'})).map(s => s.id)).toEqual([signal.id])
        expect(await local.lastSignal('greenhouse')).toBe(signal.id)
        expect((await failure(() => local.focusChunk('greenhouse', '9', {}))).status).toBe(404)
        expect((await local.focusChunk('greenhouse', 'none', {})).chunk).toBe('none')
    })

    it('can be focused on for their issues of one status', async () => {
        const local = new Store(testDb(), () => {})
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        await local.createChunk('greenhouse', {title: 'Joints'})
        expect((await local.focusChunk('greenhouse', '1', {status: 'todo'}, {name: 'skoll', owner: true})).status).toBe('todo')
        expect((await local.focusChunk('greenhouse', '1', {})).status).toBeUndefined()
        expect((await failure(() => local.focusChunk('greenhouse', '1', {status: 'done'}))).status).toBe(400)
        expect((await failure(() => local.focusChunk('greenhouse', '1', {status: 'soon'}))).status).toBe(400)
        // An old word is kept as the kind it means now, so the scope finds its issues.
        expect((await local.focusChunk('greenhouse', '1', {status: 'doing, todo'})).status).toBe('started,todo')
    })

    it('can be focused on all at once, for issues of several statuses and a release', async () => {
        const local = new Store(testDb(), () => {})
        await local.createProject({name: 'greenhouse', key: 'GRE', release_mode: 'own'})
        await local.createRelease('greenhouse', {version: '1.0.0'})
        const signal = await local.focusChunk('greenhouse', 'all', {status: 'todo, started', release: '1.0.0'}, {name: 'skoll', owner: true})
        expect(signal).toMatchObject({chunk: 'all', status: 'todo,started', release: '1.0.0'})
        expect((await failure(() => local.focusChunk('greenhouse', 'all', {status: 'todo,done'}))).message).toContain('"status" has "done"')
        expect((await failure(() => local.focusChunk('greenhouse', 'all', {release: '9.9'}))).status).toBe(404)
        await local.createIssue('greenhouse', {title: 'Hinges', status: 'todo'})
        await local.createIssue('greenhouse', {title: 'Pins', status: 'in-progress'})
        await local.createIssue('greenhouse', {title: 'Bolts'})
        expect((await local.listIssues('greenhouse', {status: 'todo,started'})).map(i => i.title)).toEqual(['Hinges', 'Pins'])
    })
})

describe('releases', () => {
    const owner: Actor = {name: 'skoll', owner: true}

    beforeEach(async () => {
        await store.updateProject('greenhouse', {release_mode: 'own'})
    })

    it("are none of a new project's until it turns them on, and go off only with none left", async () => {
        const made = await store.createProject({name: 'garden', key: 'GAR'})
        expect([made.release_mode, made.releases]).toEqual(['none', []])
        expect(await failure(() => store.createRelease('garden', {version: '1.0.0'})))
            .toEqual({status: 400, message: 'garden has no releases; turn them on with PATCH /api/projects/garden {"release_mode": "own"}'})
        expect((await failure(() => store.createIssue('garden', {title: 'Weed', release: '1.0.0'}))).status).toBe(400)
        expect((await store.updateProject('garden', {release_mode: 'own'})).release_mode).toBe('own')
        await store.createRelease('garden', {version: '1.0.0'})
        expect((await failure(() => store.updateProject('garden', {release_mode: 'none'}))).status).toBe(409)
        await store.deleteRelease('garden', '1.0.0')
        expect((await store.updateProject('garden', {release_mode: 'none'})).releases).toEqual([])
        expect((await failure(() => store.updateProject('garden', {release_mode: 'paused'}))).status).toBe(400)
    })

    it('are arranged by hand, a new one on top, and only where they are made', async () => {
        for (const version of ['1.0.0', '1.1.0', '1.2.0']) await store.createRelease('greenhouse', {version})
        const versions = async () => (await store.project('greenhouse')).releases.map(r => r.version)
        expect(await versions()).toEqual(['1.2.0', '1.1.0', '1.0.0'])
        await store.updateRelease('greenhouse', '1.0.0', {position: 0})
        expect(await versions()).toEqual(['1.0.0', '1.2.0', '1.1.0'])
        await store.updateRelease('greenhouse', '1.0.0', {position: 99})
        expect(await versions()).toEqual(['1.2.0', '1.1.0', '1.0.0'])
        await store.createRelease('greenhouse', {version: '1.3.0', position: 1})
        expect(await versions()).toEqual(['1.2.0', '1.3.0', '1.1.0', '1.0.0'])
        // Shipping it leaves it where it is.
        await store.updateRelease('greenhouse', '1.3.0', {shipped_on: '2026-10-26'})
        expect(await versions()).toEqual(['1.2.0', '1.3.0', '1.1.0', '1.0.0'])
        await store.createProject({name: 'hub', key: 'HUB', releases_from: 'greenhouse'})
        expect((await store.project('hub')).releases.map(r => r.version)).toEqual(await versions())
        expect((await failure(() => store.updateRelease('hub', '1.0.0', {position: 0}))).status).toBe(400)
    })

    it('are made by version and refuse a second of the same', async () => {
        const made = await store.createRelease('greenhouse', {version: '1.0.0-rc.2', branch: ' v1.0.0-rc.2 '})
        expect(made).toMatchObject({version: '1.0.0-rc.2', branch: 'v1.0.0-rc.2', issues: 0, tasks: [], project: 'greenhouse'})
        expect((await failure(() => store.createRelease('greenhouse', {version: '1.0.0-rc.2'}))).status).toBe(409)
        expect((await failure(() => store.createRelease('greenhouse', {version: 'one two'}))).status).toBe(400)
        expect((await failure(() => store.createRelease('greenhouse', {version: '1.0.0', shipped_on: 'today'}))).status).toBe(400)
    })

    it('count their issues, a parent with its sub-issues; the newest on top', async () => {
        await store.createRelease('greenhouse', {version: '0.8.0', shipped_on: '2026-09-01'})
        await store.createRelease('greenhouse', {version: '0.9.0', shipped_on: '2026-10-01'})
        await store.createRelease('greenhouse', {version: '1.0.0'})
        await store.createRelease('greenhouse', {version: '1.1.0'})
        const parent = await store.createIssue('greenhouse', {title: 'Hinges', chunk: '1', release: '1.0.0'})
        await store.createIssue('greenhouse', {title: 'Pin', parent: parent.id, status: 'done'})
        await store.createIssue('greenhouse', {title: 'Socket', parent: parent.id, release: '1.0.0'})
        const loose = await store.createIssue('greenhouse', {title: 'Ball joint', chunk: '1'})
        await store.createIssue('greenhouse', {title: 'Its socket', parent: loose.id, release: '1.1.0', status: 'done'})

        const [newer, older, ...shipped] = (await store.project('greenhouse')).releases
        expect(shipped.map(r => r.version)).toEqual(['0.9.0', '0.8.0'])
        expect(newer).toMatchObject({version: '1.1.0', issues: 1, kinds: {done: 1}})
        expect(older).toMatchObject({version: '1.0.0', issues: 1, kinds: {done: 1, backlog: 1}})
        expect((await store.release('greenhouse', '1.0.0')).tasks.map(t => t.id)).toEqual([parent.id])
        expect((await store.listIssues('greenhouse', {release: '1.0.0'})).map(i => i.title)).toEqual(['Hinges', 'Socket'])
        expect((await store.listIssues('greenhouse', {release: 'none'})).map(i => i.title)).toEqual(['Pin', 'Ball joint'])
        expect((await failure(() => store.listIssues('greenhouse', {release: '9.9'}))).status).toBe(404)
    })

    it("count a sub-issue set for another release there, not in its parent's", async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'})
        await store.createRelease('greenhouse', {version: '1.0.0-rc.2'})
        const parent = await store.createIssue('greenhouse', {title: 'Hinges', chunk: '1', release: '1.0.0'})
        await store.createIssue('greenhouse', {title: 'Pin', parent: parent.id})
        const early = await store.createIssue('greenhouse', {title: 'Socket', parent: parent.id, release: '1.0.0-rc.2', status: 'done'})
        await store.createIssue('greenhouse', {title: 'Its screw', parent: early.id, status: 'done'})
        await store.createIssue('greenhouse', {title: 'Its washer', parent: early.id, release: '1.0.0-rc.2'})

        const [rc, final] = (await store.project('greenhouse')).releases
        expect(rc).toMatchObject({version: '1.0.0-rc.2', issues: 1, kinds: {done: 1, backlog: 1}})
        expect(final).toMatchObject({version: '1.0.0', issues: 1, kinds: {done: 0, backlog: 1}})
        expect((await store.release('greenhouse', '1.0.0-rc.2')).tasks.map(t => t.title)).toEqual(['Socket'])
    })

    it('are set on an issue and taken off, as its activity says', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'})
        const issue = await store.createIssue('greenhouse', {title: 'Hinges'})
        expect((await store.updateIssue('greenhouse', issue.id, {release: '1.0.0'})).release).toBe('1.0.0')
        expect((await failure(() => store.updateIssue('greenhouse', issue.id, {release: '2.0.0'}))).status).toBe(404)
        expect((await store.updateIssue('greenhouse', issue.id, {release: null})).release).toBeUndefined()
        expect((await store.listActivity('greenhouse', issue.id)).filter(e => e.field === 'release').map(e => [e.before, e.after]))
            .toEqual([[undefined, '1.0.0'], ['1.0.0', undefined]])
    })

    it('change all but their version, and go leaving their issues in none', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'})
        const issue = await store.createIssue('greenhouse', {title: 'Hinges', release: '1.0.0'})
        expect(await store.updateRelease('greenhouse', '1.0.0', {notes: 'Joints.', shipped_on: '2026-10-25', branch: ''})).toMatchObject({notes: 'Joints.', shipped_on: '2026-10-25'})
        expect((await store.release('greenhouse', '1.0.0')).branch).toBeUndefined()
        expect((await failure(() => store.updateRelease('greenhouse', '1.0.0', {version: '1.0.1'}))).status).toBe(400)
        await store.deleteRelease('greenhouse', '1.0.0')
        expect((await store.issue('greenhouse', issue.id)).release).toBeUndefined()
        expect((await store.project('greenhouse')).releases).toEqual([])
    })

    it('freeze and thaw, still taking issues while frozen', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0', frozen_on: '2026-10-20'})
        const issue = await store.createIssue('greenhouse', {title: 'Hinges', release: '1.0.0'})
        expect((await store.release('greenhouse', '1.0.0')).frozen_on).toBe('2026-10-20')
        expect((await failure(() => store.updateRelease('greenhouse', '1.0.0', {frozen_on: 'now'}))).status).toBe(400)
        expect((await store.updateRelease('greenhouse', '1.0.0', {frozen_on: null})).frozen_on).toBeUndefined()
        expect((await store.issue('greenhouse', issue.id)).release).toBe('1.0.0')
    })

    it("are the owner's to delete when the owner made them", async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'}, owner)
        expect((await failure(() => store.deleteRelease('greenhouse', '1.0.0'))).status).toBe(403)
        await store.deleteRelease('greenhouse', '1.0.0', owner)
    })

    it('stay behind when their issue moves to another project', async () => {
        await store.createProject({name: 'pantry', key: 'PAN'})
        await store.createRelease('greenhouse', {version: '1.0.0'})
        const issue = await store.createIssue('greenhouse', {title: 'Hinges', release: '1.0.0'})
        const moved = await store.updateIssue('greenhouse', issue.id, {project: 'pantry'})
        expect(moved.release).toBeUndefined()
        expect((await store.project('greenhouse')).releases[0]!.issues).toBe(0)
    })

    it('go with their project', async () => {
        await store.createRelease('greenhouse', {version: '1.0.0'})
        await store.deleteProject('greenhouse')
        await store.createProject({name: 'greenhouse', key: 'GRE'})
        expect((await store.project('greenhouse')).releases).toEqual([])
    })
    describe('shared across projects', () => {
        beforeEach(async () => {
            await store.createProject({name: 'repository', key: 'REP', release_mode: 'own'})
            await store.createProject({name: 'hub', key: 'HUB', releases_from: 'repository'})
            await store.createProject({name: 'pos', key: 'POS'})
            await store.updateProject('pos', {releases_from: 'repository'})
            await store.createRelease('repository', {version: '2.25.0'})
        })

        it("let a project's issues ship in its source's releases, counted there across projects", async () => {
            const own = await store.createIssue('repository', {title: 'Release PR', release: '2.25.0'})
            const hub = await store.createIssue('hub', {title: 'Invoices', release: '2.25.0', status: 'done'})
            const pos = await store.createIssue('pos', {title: 'Receipts'})
            await store.updateIssue('pos', pos.id, {release: '2.25.0'})
            await store.createIssue('pos', {title: 'Tips', parent: pos.id})

            expect((await store.project('hub'))).toMatchObject({release_mode: 'shared', releases_from: 'repository'})
            expect((await store.project('repository')).releases[0]).toMatchObject({version: '2.25.0', issues: 3, kinds: {done: 1, backlog: 2}})
            // A project drawing on it counts its own part.
            expect((await store.project('pos')).releases[0]).toMatchObject({version: '2.25.0', issues: 1, kinds: {backlog: 1}})
            const release = await store.release('repository', '2.25.0')
            expect(release.tasks.map(t => t.id)).toEqual([own.id])
            expect(release.projects.map(p => [p.project, p.issues, p.tasks.map(t => t.id)])).toEqual([['repository', 1, [own.id]], ['hub', 1, [hub.id]], ['pos', 1, [pos.id]]])
            expect((await store.release('hub', '2.25.0')).projects.map(p => p.project)).toEqual(['hub'])
            expect((await store.listIssues('hub', {release: '2.25.0'})).map(i => i.id)).toEqual([hub.id])
            expect((await failure(() => store.createIssue('hub', {title: 'x', release: '9.9.9'}))).message).toContain('No release 9.9.9 in repository (where hub takes its releases from)')
        })

        it('are made, changed and deleted only in the source, which clears them everywhere', async () => {
            expect(await failure(() => store.createRelease('hub', {version: '2.26.0'})))
                .toEqual({status: 400, message: 'hub takes its releases from repository; make them there: /api/projects/repository/releases'})
            expect((await failure(() => store.updateRelease('hub', '2.25.0', {notes: 'x'}))).status).toBe(400)
            expect((await failure(() => store.deleteRelease('hub', '2.25.0'))).status).toBe(400)
            const hub = await store.createIssue('hub', {title: 'Invoices', release: '2.25.0'})
            await store.deleteRelease('repository', '2.25.0')
            expect((await store.issue('hub', hub.id)).release).toBeUndefined()
        })

        it('go one level deep, and never merge with releases a project already has', async () => {
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'hub'}))).message).toBe('hub takes its releases from repository; take them from repository too')
            expect((await failure(() => store.updateProject('repository', {releases_from: 'greenhouse'}))).message).toBe('hub, pos take their releases from repository, so it keeps its own')
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'greenhouse'}))).status).toBe(400)
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'nowhere'}))).status).toBe(400)
            await store.createProject({name: 'garden', key: 'GAR'})
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'garden'}))).message).toBe('garden has no releases; give it its own first (release_mode "own")')
            expect((await failure(() => store.updateProject('garden', {release_mode: 'shared'}))).status).toBe(400)
            expect((await failure(() => store.updateProject('garden', {release_mode: 'own', releases_from: 'repository'}))).status).toBe(400)
            expect((await store.updateProject('garden', {release_mode: 'shared', releases_from: 'repository'})).release_mode).toBe('shared')
            await store.createRelease('greenhouse', {version: '1.0.0'})
            expect((await failure(() => store.updateProject('greenhouse', {releases_from: 'repository'}))).status).toBe(409)
        })

        it("keep an issue's release when it moves within them, and when the project gets its own back, it has none", async () => {
            const issue = await store.createIssue('hub', {title: 'Invoices', release: '2.25.0'})
            const moved = await store.updateIssue('hub', issue.id, {project: 'pos'})
            expect(moved.release).toBe('2.25.0')
            expect((await store.updateIssue('pos', moved.id, {project: 'greenhouse'})).release).toBeUndefined()
            const other = await store.createIssue('pos', {title: 'Receipts', release: '2.25.0'})
            await store.updateProject('pos', {releases_from: null})
            expect((await store.issue('pos', other.id)).release).toBeUndefined()
            expect((await store.project('pos'))).toMatchObject({release_mode: 'own', releases: []})
            const third = await store.createIssue('hub', {title: 'Credit notes', release: '2.25.0'})
            await store.updateProject('hub', {release_mode: 'none'})
            expect((await store.issue('hub', third.id)).release).toBeUndefined()
        })

        it('keep their source from being deleted, and tell each other about changes', async () => {
            expect((await failure(() => store.deleteProject('repository'))).status).toBe(409)
            changes = []
            await store.createIssue('hub', {title: 'Invoices'})
            await store.updateRelease('repository', '2.25.0', {notes: 'Together.'})
            await new Promise(resolve => setTimeout(resolve, 10))
            expect(new Set(changes)).toEqual(new Set(['hub', 'repository', 'pos']))
        })
    })
})

describe('what sessions are told', () => {
    const owner: Actor = {name: 'skoll', owner: true}

    it("uses the project's templates, else the orrery's, else the defaults", async () => {
        expect(await store.prompts('greenhouse')).toEqual({focus: DEFAULT_FOCUS_PROMPT, chunk: DEFAULT_CHUNK_PROMPT})
        await store.updateSettings({focus_prompt: 'Look at {issue}.'}, owner)
        await store.updateProject('greenhouse', {chunk_prompt: 'Do chunk {chunk}.'}, owner)
        expect(await store.prompts('greenhouse')).toEqual({focus: 'Look at {issue}.', chunk: 'Do chunk {chunk}.'})
        await store.updateProject('greenhouse', {chunk_prompt: '  '}, owner)
        await store.updateSettings({focus_prompt: ''}, owner)
        expect(await store.prompts('greenhouse')).toEqual({focus: DEFAULT_FOCUS_PROMPT, chunk: DEFAULT_CHUNK_PROMPT})
    })

    it("are the owner's to change", async () => {
        expect((await failure(() => store.updateProject('greenhouse', {focus_prompt: 'x'}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await failure(() => store.updateSettings({instructions: []}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await store.updateProject('greenhouse', {description: 'still fine'})).description).toBe('still fine')
    })

    it('add the standing instructions ticked by default, or those picked for the send', async () => {
        const {instructions: [commit, branch]} = await store.updateSettings({instructions: [{text: 'Commit whenever a piece works'}, {text: 'Make a branch', on: false}]}, owner)
        expect([commit!.on, branch!.on, commit!.id]).toEqual([true, false, expect.stringMatching(/^[0-9a-f]{8}$/)])
        const {instructions: [tests]} = await store.updateProject('greenhouse', {instructions: [{text: 'Run the tests'}]}, owner)
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        expect((await store.focus('greenhouse', id, {}, owner)).instructions).toEqual(['Commit whenever a piece works', 'Run the tests'])
        await store.updateProject('greenhouse', {muted: [commit!.id]}, owner)
        expect((await store.focus('greenhouse', id, {}, owner)).instructions).toEqual(['Run the tests'])
        expect((await store.focusChunk('greenhouse', '1', {instructions: [branch!.id, tests!.id]}, owner)).instructions).toEqual(['Make a branch', 'Run the tests'])
        expect((await store.focus('greenhouse', id, {instructions: []}, owner)).instructions).toEqual([])
        expect((await failure(() => store.focus('greenhouse', id, {instructions: ['nope']}, owner))).status).toBe(400)
        expect((await failure(() => store.updateSettings({instructions: [{text: ''}]}, owner))).status).toBe(400)
    })
})

describe('docs', () => {
    it('list with a summary of their first paragraph, and search their title and text', async () => {
        await store.createDoc('greenhouse', {title: 'Decision: ids', body: '# Decision: ids\n\n![logo](/api/uploads/x)\n\nIssues get the project\'s **prefix** and a number, [handed out](https://x.y) by `orrery`.\nNever reused.\n\nMore later.'})
        await store.createDoc('greenhouse', {title: 'Running', body: '```sh\npnpm dev\n```\n\n' + 'word '.repeat(60)})
        const docs = await store.listDocs('greenhouse')
        expect(docs.map(d => d.summary)).toEqual([
            "Issues get the project's prefix and a number, handed out by orrery. Never reused.",
            expect.stringMatching(/^(word ){20,}word…$/),
        ])
        expect(docs[1]!.summary.length).toBeLessThanOrEqual(161)
        expect((await store.listDocs('greenhouse', {q: 'REUSED'})).map(d => [d.id, d.match])).toEqual([['decision-ids', expect.stringMatching(/^….*Never reused\..*$/)]])
        expect((await store.listDocs('greenhouse', {q: 'reused number'})).map(d => d.id)).toEqual(['decision-ids'])
        expect((await store.listDocs('greenhouse', {q: 'reused pnpm'})).map(d => d.id)).toEqual([])
        // Title hits first, then A–Z.
        expect((await store.listDocs('greenhouse', {q: 'running'})).map(d => [d.id, d.match])).toEqual([['running', '']])
        await store.createDoc('greenhouse', {title: 'About', body: 'See running.'})
        expect((await store.listDocs('greenhouse', {q: 'running'})).map(d => d.id)).toEqual(['running', 'about'])
        expect(await store.listDocs('greenhouse', {q: 'nothing like it'})).toEqual([])
    })
})

describe('the bell', () => {
    it("clears agents' comments by id or up to a time, leaving them on their issues", async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        const first = await store.createComment('greenhouse', id, {body: 'one'}, agent)
        await store.createComment('greenhouse', id, {body: 'two'}, agent)
        await store.createComment('greenhouse', id, {body: 'mine'}, {name: 'skoll', owner: true})
        expect(await store.clearNotices({ids: [first.id]})).toBe(1)
        expect((await store.notices()).map(n => n.body)).toEqual(['two'])
        expect(await store.clearNotices({before: new Date(Date.now() + 1000).toISOString()})).toBe(1)
        expect(await store.notices()).toEqual([])
        expect(await store.listComments('greenhouse', id)).toHaveLength(3)
        expect((await store.notices({list: 'cleared'})).map(n => [n.body, n.cleared])).toEqual([['two', true], ['one', true]])
        expect((await failure(() => store.clearNotices({}))).status).toBe(400)
    })
})

describe('proposals in the bell', () => {
    it("wait on the owner until they decide, ahead of the comments, and again when they're put up again", async () => {
        const agent = {name: 'claude', owner: false}
        const owner = {name: 'skoll', owner: true}
        const {id} = await store.createIssue('greenhouse', {title: 'Dark mode', notes: 'Why and how', proposal: 'pending', choices: [{key: 'k', question: 'Which?', options: [{key: 'a', title: 'A'}, {key: 'b', title: 'B'}]}]}, agent)
        await store.createIssue('greenhouse', {title: 'Its part', parent: id}, agent)
        await store.createIssue('greenhouse', {title: 'Mine', proposal: 'pending'}, owner)
        const {id: other} = await store.createIssue('greenhouse', {title: 'B'})
        await store.createComment('greenhouse', other, {body: 'Ship it?', asks: 'decision'}, agent)
        const proposal = {id: 0, issue: id, title: 'Dark mode', body: 'Why and how', asks: 'decision', answered: false, proposal: {choices: 1}}
        expect((await store.notices()).map(n => n.body)).toEqual(['Why and how', 'Ship it?'])
        expect((await store.notices())[0]).toMatchObject(proposal)
        expect((await store.notices({list: 'waiting'})).map(n => n.body)).toEqual(['Ship it?', 'Why and how'])
        expect((await store.notices({list: 'inbox'})).map(n => n.body)).toEqual([])
        // Clearing leaves it: it goes when it's decided.
        await store.clearNotices({before: new Date(Date.now() + 1000).toISOString()})
        expect((await store.notices()).map(n => n.body)).toContain('Why and how')
        await store.decide('greenhouse', id, {decision: 'changes', note: 'Shorter'}, owner)
        expect((await store.notices()).map(n => n.body)).not.toContain('Why and how')
        await store.updateIssue('greenhouse', id, {proposal: 'pending'}, agent)
        expect((await store.notices({list: 'waiting'})).map(n => n.issue)).toContain(id)
        await store.decide('greenhouse', id, {decision: 'approved', picks: {k: ['a']}}, owner)
        expect((await store.notices({list: 'waiting'})).map(n => n.issue)).not.toContain(id)
    })

    it('make the issue wait on your decision too, as the bell has it, until you decide', async () => {
        const agent = {name: 'claude', owner: false}
        const owner = {name: 'skoll', owner: true}
        const {id} = await store.createIssue('greenhouse', {title: 'Dark mode', proposal: 'pending'}, agent)
        const {id: part} = await store.createIssue('greenhouse', {title: 'Its part', parent: id, proposal: 'pending'}, agent)
        const {id: mine} = await store.createIssue('greenhouse', {title: 'Mine', proposal: 'pending'}, owner)
        expect((await store.issue('greenhouse', id)).waiting).toBe('decision')
        // Not one under another proposal, nor the owner's own.
        expect((await store.issue('greenhouse', part)).waiting).toBeUndefined()
        expect((await store.issue('greenhouse', mine)).waiting).toBeUndefined()
        // A question of its own still says what it asks.
        await store.createComment('greenhouse', id, {body: 'Thoughts?', asks: 'feedback'}, agent)
        expect((await store.issue('greenhouse', id)).waiting).toBe('feedback')
        await store.createComment('greenhouse', id, {body: 'Looks good'}, owner)
        expect((await store.issue('greenhouse', id)).waiting).toBe('decision')
        await store.decide('greenhouse', id, {decision: 'changes', note: 'Shorter'}, owner)
        expect((await store.issue('greenhouse', id)).waiting).toBeUndefined()
    })
})

describe("the notifications page's lists", () => {
    it('splits waiting from the inbox, and pages the inbox and the cleared ones newest first', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        const notes = []
        for (const body of ['one', 'two', 'three', 'four']) notes.push(await store.createComment('greenhouse', id, {body}, agent))
        await store.createComment('greenhouse', id, {body: 'Ship it?', asks: 'decision'}, agent)
        expect((await store.notices({list: 'waiting'})).map(n => n.body)).toEqual(['Ship it?'])
        const first = await store.notices({list: 'inbox', limit: 2})
        expect(first.map(n => n.body)).toEqual(['four', 'three'])
        expect((await store.notices({list: 'inbox', limit: 2, before: first.at(-1)!.id})).map(n => n.body)).toEqual(['two', 'one'])
        await store.clearNotices({ids: [notes[0]!.id, notes[1]!.id]})
        expect((await store.notices({list: 'inbox'})).map(n => n.body)).toEqual(['four', 'three'])
        expect((await store.notices({list: 'cleared', limit: 1})).map(n => [n.body, n.cleared])).toEqual([['two', true]])
        expect((await failure(() => store.notices({list: 'toString' as never}))).status).toBe(400)
    })
})

describe('comments that wait on the owner', () => {
    it('lead the bell until the owner answers, and survive Clear read', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        await store.createComment('greenhouse', id, {body: 'note'}, agent)
        const ask = await store.createComment('greenhouse', id, {body: 'Ship it?', asks: 'decision'}, agent)
        await store.createComment('greenhouse', id, {body: 'later note'}, agent)
        expect(ask).toMatchObject({asks: 'decision'})
        expect((await store.notices()).map(n => [n.body, n.answered])).toEqual([['Ship it?', false], ['later note', undefined], ['note', undefined]])
        await store.clearNotices({before: new Date(Date.now() + 1000).toISOString()})
        expect((await store.notices()).map(n => n.body)).toEqual(['Ship it?'])
        await store.createComment('greenhouse', id, {body: 'Yes'}, {name: 'skoll', owner: true})
        expect((await store.notices())[0]).toMatchObject({body: 'Ship it?', answered: true})
        expect((await store.listComments('greenhouse', id)).find(c => c.id === ask.id)).toMatchObject({asks: 'decision', answered: true})
        expect((await failure(() => store.createComment('greenhouse', id, {body: 'x', asks: 'vibes'}, agent))).status).toBe(400)
    })

    it('say on the issue what it waits on the owner for, until they comment', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        const skoll = {name: 'skoll', owner: true}
        expect((await store.issue('greenhouse', id)).waiting).toBeUndefined()
        await store.createComment('greenhouse', id, {body: 'Ship it?', asks: 'decision'}, agent)
        expect((await store.issue('greenhouse', id)).waiting).toBe('decision')
        // The latest open question is the one it waits on.
        await store.createComment('greenhouse', id, {body: 'And the copy?', asks: 'feedback'}, agent)
        expect((await store.issue('greenhouse', id)).waiting).toBe('feedback')
        // The owner's own question isn't one they wait on.
        await store.createComment('greenhouse', id, {body: 'Yes, ship it', asks: 'decision'}, skoll)
        expect((await store.issue('greenhouse', id)).waiting).toBeUndefined()
    })

    it("make the issue the owner's until they answer, then the asker's again", async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A', assignee: 'claude'})
        const agent = {name: 'claude', owner: false}
        const skoll = {name: 'skoll', owner: true}
        await store.createComment('greenhouse', id, {body: 'note'}, agent)
        expect((await store.issue('greenhouse', id)).assignee).toBe('claude')
        await store.createComment('greenhouse', id, {body: 'Ship it?', asks: 'decision'}, agent)
        expect((await store.issue('greenhouse', id)).assignee).toBe('owner')
        await store.createComment('greenhouse', id, {body: 'Yes'}, skoll)
        expect((await store.issue('greenhouse', id)).assignee).toBe('claude')
        // Answered already, so a later word from the owner leaves it with the agent.
        await store.updateIssue('greenhouse', id, {assignee: 'owner'}, skoll)
        await store.createComment('greenhouse', id, {body: 'Mine now'}, skoll)
        expect((await store.issue('greenhouse', id)).assignee).toBe('owner')
    })
})

describe("an owner's comment", () => {
    const owner = {name: 'skoll', owner: true}

    it('goes to the session that last worked the issue, while it can hear; else to every session', async () => {
        const sent: (string | undefined)[] = []
        const local = new Store(testDb(), () => {}, signal => signal.kind === 'comment' && sent.push(signal.target))
        let listening = ['window-a', 'window-b']
        local.hears = (_project, session) => listening.includes(session)
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const {id} = await local.createIssue('greenhouse', {title: 'Shelves'})
        await local.createComment('greenhouse', id, {body: 'nobody yet'}, owner)
        await local.workedBy('greenhouse', id, 'window-a')
        await local.createComment('greenhouse', id, {body: 'a has it'}, owner)
        await local.focus('greenhouse', id, {session: 'window-b'}, owner)
        await local.createComment('greenhouse', id, {body: 'b was asked'}, owner)
        listening = ['window-a']
        await local.createComment('greenhouse', id, {body: 'b is gone'}, owner)
        expect(sent).toEqual([undefined, 'window-a', 'window-b', undefined])
        // Noting a worker on an issue that isn't there does nothing.
        await local.workedBy('greenhouse', 'GRE-99', 'window-a')
    })

    it('goes again, marked as an edit, when the owner changes its words', async () => {
        const sent: (string | null)[] = []
        const local = new Store(testDb(), () => {}, signal => signal.kind === 'comment' && sent.push(signal.note ?? null))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const {id} = await local.createIssue('greenhouse', {title: 'Shelves'})
        const comment = await local.createComment('greenhouse', id, {body: 'Use oak'}, owner)
        await local.updateComment('greenhouse', id, comment.id, {body: 'Use pine'}, owner)
        // The same words again, or only the ask changing, isn't news.
        await local.updateComment('greenhouse', id, comment.id, {body: 'Use pine'}, owner)
        await local.updateComment('greenhouse', id, comment.id, {asks: 'feedback'}, owner)
        expect(sent).toEqual(['Use oak', '(Edited: this replaces their earlier comment.)\n\nUse pine'])
    })
})

describe('starting sessions', () => {
    const owner = {name: 'skoll', owner: true}

    it("is the owner's to allow once for every project, as {limit, minutes?, idle_minutes?}, and to stop with null", async () => {
        await store.createProject({name: 'pantry', key: 'PAN'})
        expect((await store.settings()).starts).toBeNull()
        expect((await store.project('greenhouse')).starts).toBeUndefined()
        expect((await failure(() => store.updateSettings({starts: {limit: 1, minutes: 30}}))).status).toBe(403)
        changes.length = 0
        expect((await store.updateSettings({starts: {limit: 2, minutes: 30}}, owner)).starts).toEqual({limit: 2, minutes: 30})
        // Every project has it, and says so.
        expect((await store.project('pantry')).starts).toEqual({limit: 2, minutes: 30})
        expect(changes.sort()).toEqual(['greenhouse', 'pantry'])
        // Without minutes, they run until stopped; idle minutes stop one that has nothing to do.
        expect((await store.updateSettings({starts: {limit: 2}}, owner)).starts).toEqual({limit: 2})
        expect((await store.updateSettings({starts: {limit: 2, minutes: null, idle_minutes: 60}}, owner)).starts).toEqual({limit: 2, idle_minutes: 60})
        for (const wrong of [{limit: 0, minutes: 30}, {minutes: 30}, {limit: 2, minutes: 0}, {limit: 2, idle_minutes: 1441}, {limit: 2, minutes: 30, model: 'x'}, {limit: 1.5, minutes: 30}, 'yes']) {
            expect((await failure(() => store.updateSettings({starts: wrong}, owner))).status).toBe(400)
        }
        expect((await store.updateSettings({starts: null}, owner)).starts).toBeNull()
        expect((await store.project('greenhouse')).starts).toBeUndefined()
        // A project has none of its own.
        expect((await failure(() => store.updateProject('greenhouse', {starts: {limit: 1}}, owner))).status).toBe(400)
    })

    it('reads without building the board', async () => {
        await store.updateSettings({starts: {limit: 1, minutes: 45}}, owner)
        expect(await store.starts('greenhouse')).toEqual({limit: 1, minutes: 45})
        expect((await failure(() => store.starts('nope'))).status).toBe(404)
    })
})

describe('a signal reaching sessions', () => {
    it('keeps every session that says it got it, however many say so at once', async () => {
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        const signal = await store.focus('greenhouse', jars, {}, {name: 'skoll', owner: true})
        await Promise.all(['greenhouse 1', 'greenhouse 2', 'pantry'].map(name => store.delivered('greenhouse', signal.id, name)))
        const [heard] = await store.listSignals('greenhouse', signal.id - 1)
        expect([...heard!.delivered_to].sort()).toEqual(['greenhouse 1', 'greenhouse 2', 'pantry'])
    })

    it("says so when it can't keep a session's receipt, rather than one it didn't save", async () => {
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        const signal = await store.focus('greenhouse', jars, {}, {name: 'skoll', owner: true})
        // Every write loses its race to another session's.
        const losing = Object.assign(Object.create(store) as Store, {run: async () => ({changes: 0})})
        expect((await failure(() => losing.delivered('greenhouse', signal.id, 'greenhouse 1'))).status).toBe(409)
        const [heard] = await store.listSignals('greenhouse', signal.id - 1)
        expect(heard!.delivered_to).toEqual([])
    })
})

describe('a focus aimed at no session', () => {
    it("goes to the session already on its issue while it's listening, else to one orrery picks", async () => {
        const owner = {name: 'skoll', owner: true}
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        expect((await store.focus('greenhouse', jars, {}, owner)).target).toBeUndefined()
        await store.workedBy('greenhouse', jars, 'a')
        store.hears = () => true
        expect((await store.focus('greenhouse', jars, {}, owner)).target).toBe('a')
        expect((await store.focus('greenhouse', jars, {session: '*'}, owner)).target).toBe('*')
        store.hears = () => false
        expect((await store.focus('greenhouse', jars, {}, owner)).target).toBeUndefined()
    })

    it('waits for the next session to go idle while nobody has heard it', async () => {
        const owner = {name: 'skoll', owner: true}
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        const one = await store.focus('greenhouse', jars, {}, owner)
        await store.focus('greenhouse', jars, {session: 'b'}, owner)
        const chunk = await store.focusChunk('greenhouse', 'all', {}, owner)
        expect((await store.pooledWaiting('greenhouse')).map(s => s.id)).toEqual([one.id, chunk.id])
        await store.delivered('greenhouse', one.id, 'pantry')
        expect((await store.pooledWaiting('greenhouse')).map(s => s.id)).toEqual([chunk.id])
    })
})

describe("what a project's sessions are on", () => {
    it('is the open issues each worked last, newest first, and the last signals that went to it', async () => {
        const owner = {name: 'skoll', owner: true}
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-progress'})).id
        const jars = (await store.createIssue('greenhouse', {title: 'Jars'})).id
        const lids = (await store.createIssue('greenhouse', {title: 'Lids', status: 'done'})).id
        await store.workedBy('greenhouse', shelves, 'a')
        await store.workedBy('greenhouse', lids, 'a')
        await store.workedBy('greenhouse', jars, 'a')
        // a is gone by then, so the focus hands Shelves to b.
        store.hears = (_project, session) => session !== 'a'
        await store.focus('greenhouse', shelves, {session: 'b'}, owner)
        store.hears = () => true
        const everyone = await store.focus('greenhouse', jars, {session: '*'}, owner)
        await store.delivered('greenhouse', everyone.id, 'pantry')
        const work = await store.sessionWork('greenhouse', [{id: 'a', name: 'greenhouse 1'}, {id: 'b', name: 'pantry'}])
        expect(work.a!.issues.map(i => i.id)).toEqual([jars])
        expect(work.a!.signals).toEqual([])
        // b was asked to focus on Shelves, which makes it Shelves' worker; and it heard the focus on Jars sent to all.
        expect(work.b!.issues.map(i => i.id)).toEqual([shelves])
        expect(work.b!.signals.map(s => s.issue)).toEqual([jars, shelves])
        // After a /clear, b goes by a new id and keeps what it did under the old one, each issue once.
        await store.workedBy('greenhouse', shelves, 'b2')
        const cleared = await store.sessionWork('greenhouse', [{id: 'b2', name: 'pantry', ids: ['b2', 'b']}])
        expect(cleared.b2!.issues.map(i => i.id)).toEqual([shelves])
        expect(cleared.b2!.signals.map(s => s.issue)).toEqual([jars, shelves])
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

describe('presets', () => {
    it('refuse a name or text of only spaces, made or changed', async () => {
        const owner = {name: 'skoll', owner: true}
        expect((await failure(() => store.createPreset(null, {name: '  ', text: 'x'}, owner))).status).toBe(400)
        expect((await failure(() => store.createPreset(null, {name: 'Review', text: ' \n '}, owner))).status).toBe(400)
        const made = await store.createPreset(null, {name: ' Review ', text: ' Read the diff. '}, owner)
        expect(made).toMatchObject({name: 'Review', text: 'Read the diff.'})
        expect((await failure(() => store.updatePreset(made.id, {text: ' '}, owner))).status).toBe(400)
        expect((await store.preset(made.id)).text).toBe('Read the diff.')
    })

    const owner: Actor = {name: 'skoll', owner: true}
    const claude: Actor = {name: 'claude', owner: false}

    it("are the owner's to make: the orrery's for any project, or a project's own", async () => {
        expect((await failure(() => store.createPreset(null, {name: 'Review', text: "You're reviewing."}, claude))).status).toBe(403)
        expect((await failure(() => store.createPreset(null, {name: ' ', text: 'x'}, owner))).status).toBe(400)
        const review = await store.createPreset(null, {name: ' Review ', text: "You're reviewing: don't change code."}, owner)
        expect(review).toMatchObject({project: null, name: 'Review', text: "You're reviewing: don't change code."})
        await store.createProject({name: 'pantry', key: 'PAN'})
        const e2e = await store.createPreset('greenhouse', {name: 'E2E', text: 'Run pnpm test:e2e before you finish.'}, owner)
        await store.createPreset('pantry', {name: 'Pantry only', text: 'Mind the jars.'}, owner)
        expect((await failure(() => store.createPreset('nowhere', {name: 'x', text: 'y'}, owner))).status).toBe(404)
        // A session on a project can have the orrery's, then its own; another project's aren't among them.
        expect((await store.presets()).map(p => p.name)).toEqual(['Review'])
        expect((await store.presets('greenhouse')).map(p => p.name)).toEqual(['Review', 'E2E'])
        expect((await store.presetsFor('greenhouse', [e2e.id, review.id, e2e.id])).map(p => p.name)).toEqual(['E2E', 'Review'])
        const pantry = (await store.presets('pantry')).find(p => p.project === 'pantry')!
        expect((await failure(() => store.presetsFor('greenhouse', [pantry.id]))).message).toMatch(`No preset ${pantry.id} for greenhouse`)
    })

    it('are renamed, rewritten and removed by the owner, and go with their project', async () => {
        const preset = await store.createPreset('greenhouse', {name: 'E2E', text: 'Run the e2e suite.'}, owner)
        expect((await failure(() => store.updatePreset(preset.id, {text: 'Skip it.'}, claude))).status).toBe(403)
        expect(await store.updatePreset(preset.id, {text: 'Run pnpm test:e2e.'}, owner)).toMatchObject({name: 'E2E', text: 'Run pnpm test:e2e.'})
        expect((await failure(() => store.updatePreset(preset.id, {text: ''}, owner))).status).toBe(400)
        expect((await failure(() => store.updatePreset(preset.id, {name: '   '}, owner))).status).toBe(400)
        await store.deletePreset(preset.id, owner)
        expect((await failure(() => store.preset(preset.id))).status).toBe(404)
        await store.createPreset('greenhouse', {name: 'E2E', text: 'Run the e2e suite.'}, owner)
        await store.deleteProject('greenhouse', owner)
        expect(await store.presets()).toEqual([])
    })
    it('have a badge: an icon and a colour, each taken off with null', async () => {
        const review = await store.createPreset(null, {name: 'Review', text: 'Read the diff.', icon: 'shield-check', color: 'violet'}, owner)
        expect(review).toMatchObject({icon: 'shield-check', color: 'violet'})
        expect((await store.createPreset(null, {name: 'Test', text: 'Run the tests.'}, owner))).toMatchObject({icon: null, color: null})
        expect((await failure(() => store.updatePreset(review.id, {icon: 'Shield Check'}, owner))).status).toBe(400)
        expect((await failure(() => store.updatePreset(review.id, {color: 'plaid'}, owner))).status).toBe(400)
        expect(await store.updatePreset(review.id, {color: '#3b82f6'}, owner)).toMatchObject({icon: 'shield-check', color: '#3b82f6', text: 'Read the diff.'})
        expect(await store.updatePreset(review.id, {icon: null}, owner)).toMatchObject({icon: null, color: '#3b82f6'})
    })
})

describe('statuses', () => {
    const owner = {name: 'skoll', owner: true}

    it('start as Backlog, Todo, In progress, In review, Done and Canceled, in board order', async () => {
        expect((await store.statuses()).map(s => `${s.id}:${s.kind}`)).toEqual(['backlog:backlog', 'todo:todo', 'in-progress:started', 'in-review:started', 'done:done', 'canceled:canceled'])
        expect((await store.settings()).statuses).toHaveLength(6)
    })

    it('take an id, a kind, or the words from before statuses', async () => {
        const status = async (body: Record<string, unknown>) => (await store.createIssue('greenhouse', {title: 'x', ...body})).status
        expect(await status({status: 'in-review'})).toBe('in-review')
        expect(await status({status: 'started'})).toBe('in-progress')
        expect(await status({status: 'doing'})).toBe('in-progress')
        expect(await status({status: 'todo', plan: 'next'})).toBe('todo')
        expect(await status({status: 'todo', plan: null})).toBe('backlog')
        expect(await status({plan: 'now'})).toBe('todo')
        expect(await status({})).toBe('backlog')
        expect((await failure(() => status({status: 'soon'}))).status).toBe(400)
        const a = (await store.createIssue('greenhouse', {title: 'A', status: 'todo'})).id
        expect((await store.updateIssue('greenhouse', a, {status: 'canceled'})).kind).toBe('canceled')
        expect((await store.listIssues('greenhouse', {status: 'started'})).map(i => i.status)).toEqual(['in-review', 'in-progress', 'in-progress'])
        expect((await store.listIssues('greenhouse', {column: 'canceled'})).map(i => i.id)).toEqual([a])
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

        const id = (await store.createIssue('greenhouse', {title: 'Stuck', status: 'blocked'})).id
        expect((await failure(() => store.deleteStatus('blocked', undefined, owner))).status).toBe(409)
        await store.deleteStatus('blocked', 'in-progress', owner)
        expect((await store.issue('greenhouse', id)).status).toBe('in-progress')
        expect((await failure(() => store.deleteStatus('todo', 'backlog', owner))).status).toBe(409)
        expect((await failure(() => store.status('blocked'))).status).toBe(404)
    })

    it('narrow a chunk focus to an open one, by id or kind', async () => {
        const signal = async (status: string) => (await store.focusChunk('greenhouse', '1', {status}, owner)).status
        expect(await signal('in-review')).toBe('in-review')
        expect(await signal('started')).toBe('started')
        expect((await failure(() => signal('done'))).status).toBe(400)
        expect((await failure(() => signal('canceled'))).status).toBe(400)
    })
})

describe('settings', () => {
    it('give the orrery an id the first time, kept after', async () => {
        const {id} = await store.settings()
        expect(id).toMatch(/^orr_[0-9a-f]{6}$/)
        expect((await store.settings()).id).toBe(id)
        expect((await failure(() => store.updateSettings({id: 'orr_000000'}, {name: 'skoll', owner: true}))).status).toBe(400)
    })

    it('keep a tint, the owner’s to change', async () => {
        expect((await store.settings()).tint).toBeNull()
        expect((await store.updateSettings({tint: 'blue'}, {name: 'skoll', owner: true})).tint).toBe('blue')
        expect((await store.updateSettings({tint: '#123abc'}, {name: 'skoll', owner: true})).tint).toBe('#123abc')
        expect((await failure(() => store.updateSettings({tint: 'red; background: url(x)'}, {name: 'skoll', owner: true}))).status).toBe(400)
        expect((await failure(() => store.updateSettings({tint: null}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await store.updateSettings({tint: null}, {name: 'skoll', owner: true})).tint).toBeNull()
    })

    it("give every issue a reference saying whose board it's on, by the owner's handle or else their id", async () => {
        const owner = {name: 'skoll', owner: true}
        const {id} = await store.createIssue('greenhouse', {title: 'Hinges'})
        expect((await store.issue('greenhouse', id)).ref).toBe(`orrery-owner: ${id}`)
        expect((await store.updateSettings({handle: 'SkollF'}, owner)).handle).toBe('skollf')
        expect((await store.issue('greenhouse', id)).ref).toBe(`orrery-skollf: ${id}`)
        expect((await store.listIssues('greenhouse'))[0]!.ref).toBe(`orrery-skollf: ${id}`)
        expect((await store.updateIssue('greenhouse', id, {title: 'Pins'})).ref).toBe(`orrery-skollf: ${id}`)
        expect((await failure(() => store.updateSettings({handle: 'no spaces'}, owner))).status).toBe(400)
        expect((await failure(() => store.updateSettings({handle: 'x'}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await store.updateSettings({handle: null}, owner)).handle).toBeNull()
    })

    it("link an issue to its tasks on the team's tracker, found by them, its activity saying so", async () => {
        const owner = {name: 'skoll', owner: true}
        const {id} = await store.createIssue('greenhouse', {title: 'Hinges', external: [' ENG-1567 ', 'ENG-1567']})
        expect((await store.issue('greenhouse', id)).external).toEqual(['ENG-1567'])
        await store.createIssue('greenhouse', {title: 'Pins'})
        expect((await store.updateIssue('greenhouse', id, {external: ['ENG-1567', 'https://tracker.example.com/issue/ENG-9']})).external).toEqual(['ENG-1567', 'https://tracker.example.com/issue/ENG-9'])
        expect((await store.listIssues('greenhouse', {external: 'ENG-1567'})).map(i => i.id)).toEqual([id])
        expect((await store.listActivity('greenhouse', id)).filter(e => e.field === 'external').map(e => [e.before, e.after]))
            .toEqual([['["ENG-1567"]', '["ENG-1567","https://tracker.example.com/issue/ENG-9"]']])
        expect((await store.updateIssue('greenhouse', id, {external: null})).external).toEqual([])
        expect((await store.updateSettings({tracker: 'https://tracker.example.com/issue/{id}'}, owner)).tracker).toBe('https://tracker.example.com/issue/{id}')
        expect((await failure(() => store.updateSettings({tracker: 'https://tracker.example.com'}, owner))).status).toBe(400)
    })
})

describe('the terminal Watch opens', () => {
    const owner = {name: 'skoll', owner: true}

    it("is Terminal until the owner picks another of those Watch knows", async () => {
        expect((await store.settings()).terminal).toBe('terminal')
        expect((await store.updateSettings({terminal: 'warp'}, owner)).terminal).toBe('warp')
        expect((await failure(() => store.updateSettings({terminal: 'xterm'}, owner))).status).toBe(400)
        expect((await failure(() => store.updateSettings({terminal: 'iterm'}, {name: 'claude', owner: false}))).status).toBe(403)
        expect((await store.updateSettings({terminal: null}, owner)).terminal).toBe('terminal')
    })
})

describe('many issues at once', () => {
    const owner = {name: 'skoll', owner: true}

    it('take one change each on its own, labels added and taken off, saying which were refused', async () => {
        const a = await store.createIssue('greenhouse', {title: 'A', labels: ['ui', 'old']})
        const b = await store.createIssue('greenhouse', {title: 'B'})
        changes = []
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

describe('a session that connects', () => {
    it("gets the owner's comments that no agent has answered", async () => {
        const sent: string[] = []
        const local = new Store(testDb(), () => {}, signal => sent.push(`${signal.issue}:${signal.target}:${signal.note}`))
        await local.createProject({name: 'greenhouse', key: 'GRE'})
        const me = {name: 'skoll', owner: true}
        const a = (await local.createIssue('greenhouse', {title: 'A'})).id
        const b = (await local.createIssue('greenhouse', {title: 'B'})).id
        await local.createComment('greenhouse', a, {body: 'answer me'}, me)
        await local.createComment('greenhouse', b, {body: 'answered'}, me)
        await local.createComment('greenhouse', b, {body: 'here you go'}, {name: 'claude', owner: false})
        sent.length = 0
        expect(await local.carryUnanswered('greenhouse', 'new-window')).toBe(1)
        expect(sent).toEqual([`${a}:new-window:answer me`])
    })
})

describe('what a session is working on', () => {
    it('is the started issues any of its ids worked last, with their latest comment', async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-progress'})).id
        const jars = (await store.createIssue('greenhouse', {title: 'Jars', status: 'in-review'})).id
        const lids = (await store.createIssue('greenhouse', {title: 'Lids', status: 'done'})).id
        const theirs = (await store.createIssue('greenhouse', {title: 'Theirs', status: 'in-progress'})).id
        for (const issue of [shelves, lids]) await store.workedBy('greenhouse', issue, 'before-clear')
        await store.workedBy('greenhouse', jars, 'after-clear')
        await store.workedBy('greenhouse', theirs, 'other-window')
        await store.createComment('greenhouse', shelves, {body: 'first'})
        await store.createComment('greenhouse', shelves, {body: 'halfway'})
        const working = await store.workingOn('greenhouse', ['after-clear', 'before-clear'])
        expect(working.map(i => [i.id, i.last?.body])).toEqual([[shelves, 'halfway'], [jars, undefined]])
        expect(await store.workingOn('greenhouse', [])).toEqual([])
    })

    it("moves to a session's new id: what it worked and the signals sent to it", async () => {
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves', status: 'in-progress'})).id
        await store.workedBy('greenhouse', shelves, 'before-clear')
        await store.focus('greenhouse', shelves, {session: 'before-clear'})
        await store.renameSession('greenhouse', 'before-clear', 'after-clear')
        expect((await store.workingOn('greenhouse', ['after-clear'])).map(i => i.id)).toEqual([shelves])
        expect(await store.workingOn('greenhouse', ['before-clear'])).toEqual([])
        expect((await store.listSignals('greenhouse')).map(s => s.target)).toEqual(['after-clear'])
    })
})

describe('a message to one session', () => {
    const owner = {name: 'skoll', owner: true}

    it("is the owner's, as text, a message signal for that session alone", async () => {
        expect((await failure(() => store.messageSession('greenhouse', 'abc', 'Look at the hinges'))).status).toBe(403)
        expect((await failure(() => store.messageSession('greenhouse', 'abc', '  ', owner))).status).toBe(400)
        expect((await failure(() => store.messageSession('nope', 'abc', 'Hi', owner))).status).toBe(404)
        const signal = await store.messageSession('greenhouse', 'abc', ' Look at the hinges\n', owner)
        expect(signal).toMatchObject({kind: 'message', note: 'Look at the hinges', target: 'abc', schedule: undefined, issue: undefined, created_by: 'skoll', protected: true})
        // Nobody else catches up on it, but the session it's for does, if it wasn't there to hear it.
        expect((await store.unheardScheduled('greenhouse')).map(s => s.target)).toEqual(['abc'])
    })

    it("sent by the owner's chat for them says so", async () => {
        const signal = await store.messageSession('greenhouse', 'abc', 'Pick up Todo.', {...owner, via: 'chat'})
        expect(signal).toMatchObject({kind: 'message', created_by: 'skoll', protected: true, via: 'chat'})
        expect((await store.listSignals('greenhouse')).find(s => s.id === signal.id)!.via).toBe('chat')
        expect(await store.messageSession('greenhouse', 'abc', 'Hi', owner)).not.toHaveProperty('via')
    })

    it("from a preset is its text as the owner sent it, labelled by the preset's name as it was then", async () => {
        const release = await store.createPreset('greenhouse', {name: 'Release', text: 'Cut the release.'}, owner)
        await store.createProject({name: 'pantry', key: 'PAN'})
        const jars = await store.createPreset('pantry', {name: 'Jars', text: 'Mind the jars.'}, owner)
        const signal = await store.messageSession('greenhouse', 'abc', 'Cut the release, for rc.9.', owner, release.id)
        expect(signal).toMatchObject({kind: 'message', note: 'Cut the release, for rc.9.', preset: 'Release', target: 'abc'})
        await store.updatePreset(release.id, {name: 'Ship it'}, owner)
        expect((await store.listSignals('greenhouse')).find(s => s.id === signal.id)!.preset).toBe('Release')
        // Another project's preset, one that isn't there, or not an id, is refused; without one, it's plain words.
        expect((await failure(() => store.messageSession('greenhouse', 'abc', 'Hi', owner, jars.id))).status).toBe(400)
        expect((await failure(() => store.messageSession('greenhouse', 'abc', 'Hi', owner, 999))).status).toBe(400)
        expect((await failure(() => store.messageSession('greenhouse', 'abc', 'Hi', owner, 'Release'))).status).toBe(400)
        expect((await store.messageSession('greenhouse', 'abc', 'Hi', owner)).preset).toBeUndefined()
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

describe('docs', () => {
    it('are listed with the project, without their text', async () => {
        const doc = await store.createDoc('greenhouse', {title: 'How joints work', body: '# Joints\n\nA **hinge** turns.'})
        expect(doc).toMatchObject({id: 'how-joints-work', created_by: 'agent', protected: false})
        expect((await store.project('greenhouse')).docs.map(d => d.id)).toEqual(['how-joints-work'])
        expect((await store.project('greenhouse')).docs[0]).not.toHaveProperty('body')
        expect((await store.doc('greenhouse', doc.id)).body).toContain('**hinge**')
    })

    it('are listed by title, A–Z, whatever order they were made in', async () => {
        for (const title of ['Running', 'decision: ids', 'API', 'Decision: owner']) await store.createDoc('greenhouse', {title})
        expect((await store.listDocs('greenhouse')).map(d => d.title)).toEqual(['API', 'decision: ids', 'Decision: owner', 'Running'])
    })

    it('are created or replaced at their id with PUT', async () => {
        expect((await store.putDoc('greenhouse', 'readme', {title: 'Readme', body: 'one'})).created).toBe(true)
        const {doc, created} = await store.putDoc('greenhouse', 'readme', {title: 'README', body: 'two'})
        expect([created, doc.title, doc.body]).toEqual([false, 'README', 'two'])
        expect((await failure(() => store.putDoc('greenhouse', 'Bad Id', {title: 'x'}))).status).toBe(400)
    })

    it("are the owner's to delete when the owner wrote them", async () => {
        await store.createDoc('greenhouse', {id: 'mine', title: 'Mine'}, {name: 'skoll', owner: true})
        expect((await failure(() => store.deleteDoc('greenhouse', 'mine'))).status).toBe(403)
        expect((await failure(() => store.deleteProject('greenhouse'))).status).toBe(403)
        await store.deleteDoc('greenhouse', 'mine', {name: 'skoll', owner: true})
        expect(await store.listDocs('greenhouse')).toEqual([])
    })
})

describe('images', () => {
    // A 1×1 PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

    it('keeps one, and hands back where it is and the Markdown that shows it', async () => {
        const image = await store.createUpload({data: `data:image/png;base64,${png}`, name: 'Shelf [left].png'})
        expect(image).toMatchObject({type: 'image/png', size: 70, url: `/api/uploads/${image.id}`, markdown: `![Shelf left](/api/uploads/${image.id})`})
        const kept = await store.upload(image.id)
        expect(kept.type).toBe('image/png')
        expect(kept.data.equals(Buffer.from(png, 'base64'))).toBe(true)
    })

    it('tells the type by the bytes, and takes no SVG or anything else', async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')
        expect(await failure(() => store.createUpload({data: `data:image/png;base64,${svg}`})))
            .toEqual({status: 400, message: "That isn't a PNG, JPEG, GIF or WebP image"})
        expect((await failure(() => store.createUpload({data: 'not base64!'}))).status).toBe(400)
        expect((await failure(() => store.createUpload({data: ''}))).status).toBe(400)
    })

    it('refuses one over the limit', async () => {
        const big = Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(UPLOAD_LIMIT)]).toString('base64')
        expect((await failure(() => store.createUpload({data: big}))).message).toMatch(/MB at most/)
    })

    it("answers 404 for one that isn't there", async () => {
        expect((await failure(() => store.upload('0'.repeat(24)))).status).toBe(404)
        expect((await failure(() => store.upload('../etc'))).status).toBe(404)
    })
})

describe('the database', () => {
    it("makes letting orrery start sessions the orrery's one setting, from the first project that had it", async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 34)
        old.prepare(`INSERT INTO projects (id, name, key, starts, created_by, created_at, updated_at) VALUES
            ('greenhouse', 'greenhouse', 'GRE', NULL, 'agent', '1', '1'), ('pantry', 'pantry', 'PAN', '{"limit":2,"minutes":60}', 'agent', '2', '2'),
            ('cellar', 'cellar', 'CEL', '{"limit":5}', 'agent', '3', '3')`).run()
        old.close()
        const upgraded = new Store(new SqliteDb(openDb(path)))
        expect((await upgraded.settings()).starts).toEqual({limit: 2, minutes: 60})
        expect((await upgraded.project('greenhouse')).starts).toEqual({limit: 2, minutes: 60})
        const none = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'none.db')
        openDb(none, 34).close()
        expect((await new Store(new SqliteDb(openDb(none))).settings()).starts).toBeNull()
    })

    it('puts the proposals approved before on the roadmap, in Todo', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 30)
        old.prepare("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x')").run()
        old.prepare("INSERT INTO issues (project, id, title, status, proposal, decided_by, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'GRE-1', 'A', 'backlog', 'approved', 'skoll', 0, 'agent', 'x', 'x'), ('greenhouse', 'GRE-2', 'B', 'backlog', 'pending', NULL, 1, 'agent', 'x', 'x'), ('greenhouse', 'GRE-3', 'C', 'done', 'approved', 'skoll', 2, 'agent', 'x', 'x')").run()
        old.close()
        const upgraded = new Store(new SqliteDb(openDb(path)))
        expect([(await upgraded.issue('greenhouse', 'GRE-1')).column, (await upgraded.issue('greenhouse', 'GRE-1')).decided_by]).toEqual(['todo', 'skoll'])
        expect((await upgraded.issue('greenhouse', 'GRE-2')).proposal).toBe('pending')
        // One its work already finished stays done.
        expect((await upgraded.issue('greenhouse', 'GRE-3'))).toMatchObject({column: 'done', proposal: undefined})
    })

    it("keeps the orrery's prompts through the API going snake_case", async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 27)
        old.prepare(`INSERT INTO settings (key, value) VALUES ('focusPrompt', '"Look at {issue}"'), ('chunkPrompt', '"Work {chunk}"')`).run()
        old.close()
        expect(await new Store(new SqliteDb(openDb(path))).settings()).toMatchObject({focus_prompt: 'Look at {issue}', chunk_prompt: 'Work {chunk}'})
    })

    it('keeps its data through the migrations and gives it project ids, the old ones as aliases', async () => {
        const path = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'old.db')
        const old = openDb(path, 2)
        const row = (sql: string) => old.prepare(sql).run()
        row("INSERT INTO projects (id, name, key, created_by, created_at, updated_at) VALUES ('greenhouse', 'greenhouse', 'GRE', 'agent', 'x', 'x')")
        row("INSERT INTO chunks (project, id, title, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'ux', 'UX', 1, 'agent', 'x', 'x')")
        row("INSERT INTO chunks (project, id, title, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'joints', 'Joints', 0, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, chunk, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'UX-1', 'ux', 'ux', 0, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, chunk, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'MOT-5', 'joint', 'joints', 1, 'agent', 'x', 'x')")
        row("INSERT INTO issues (project, id, title, parent, position, created_by, created_at, updated_at) VALUES ('greenhouse', 'GRE-1', 'sub', 'MOT-5', 2, 'agent', 'x', 'x')")
        row("INSERT INTO comments (project, issue, body, created_by, created_at, updated_at) VALUES ('greenhouse', 'MOT-5', 'hi', 'agent', 'x', 'x')")
        old.close()

        const upgraded = new Store(new SqliteDb(openDb(path)))
        const {board} = await upgraded.project('greenhouse')
        expect(board.chunks.map(c => [c.id, c.title, c.aliases])).toEqual([['1', 'Joints', ['joints']], ['2', 'UX', ['ux']]])
        // GRE-1 was already the project's kind of id, so it keeps it; the others take the next numbers.
        expect(board.chunks[0]!.tasks.map(t => [t.id, t.aliases, t.tasks.map(s => s.id)])).toEqual([['GRE-2', ['MOT-5'], ['GRE-1']]])
        expect(board.chunks[1]!.tasks.map(t => [t.id, t.aliases])).toEqual([['GRE-3', ['UX-1']]])
        expect((await upgraded.issue('greenhouse', 'MOT-5')).id).toBe('GRE-2')
        expect((await upgraded.listComments('greenhouse', 'MOT-5')).map(c => c.body)).toEqual(['hi'])
        expect((await upgraded.chunk('greenhouse', 'joints')).id).toBe('1')
        expect(await upgraded.createIssue('greenhouse', {title: 'new', chunk: 'ux'})).toMatchObject({id: 'GRE-4', chunk: '2'})
        expect((await upgraded.createChunk('greenhouse', {title: 'Print'})).id).toBe('3')
        expect((await upgraded.updateIssue('greenhouse', 'GRE-4', {priority: 'P0'})).priority).toBe('P0')
    })

    // On Postgres as a SQLite snapshot, so a new SQLite orrery starts from it either way.
    it('is backed up to a folder and restored from it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-'))
        const cloud = join(dir, 'cloud')
        const {id} = await store.createIssue('greenhouse', {title: 'saved'})
        expect(lastBackup(cloud)).toBeUndefined()
        // Two at once: the second waits for the first rather than writing over it.
        await Promise.all([backUp(store.db, cloud), backUp(store.db, cloud)])
        expect(lastBackup(cloud)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
        // One file each, the latest and today's, with nothing left beside them.
        expect(readdirSync(cloud).sort()).toEqual(['orrery.db', `orrery-${new Date().toISOString().slice(0, 10)}.db`].sort())

        const fresh = join(dir, 'new', 'orrery.db')
        restoreBackup(fresh, cloud)
        expect((await new Store(new SqliteDb(openDb(fresh))).issue('greenhouse', id)).title).toBe('saved')
    })

    it("is copied whole into a SQLite snapshot, as a Postgres one is, whatever it's on", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), 'orrery-')), 'cloud')
        const {id} = await store.createIssue('greenhouse', {title: 'snapped'})
        await backupPostgres(store.db, dir)
        expect(readdirSync(dir)).toContain('orrery.db')
        expect(readdirSync(dir).filter(name => name.includes('partial') || name.endsWith('-wal'))).toEqual([])
        expect((await new Store(new SqliteDb(openDb(join(dir, 'orrery.db')))).issue('greenhouse', id)).title).toBe('snapped')

        // Each from the schema laid down once, up to date, with nothing of the last one left in it.
        await store.updateIssue('greenhouse', id, {title: 'snapped again'})
        await backupPostgres(store.db, dir)
        const again = new DatabaseSync(join(dir, 'orrery.db'))
        const version = (raw: DatabaseSync) => (raw.prepare('PRAGMA user_version').get() as {user_version: number}).user_version
        expect(version(again)).toBe(version(openDb(':memory:')))
        expect(again.prepare('SELECT title FROM issues').all().map(row => row.title)).toEqual(['snapped again'])
    })
})

describe('import', () => {
    const roadmap = readRoadmap(readFileSync(new URL('./fixtures/greenhouse-roadmap.json', import.meta.url), 'utf8'))

    it("loads greenhouse's roadmap", async () => {
        expect((await failure(() => store.importRoadmap('greenhouse', roadmap))).status).toBe(409)
        const {board} = await store.importRoadmap('greenhouse', roadmap, true)
        expect(board.chunks).toHaveLength(16)
        expect(total(board.kinds)).toBe(139)
        // Chunk 1 was the one it replaced, so its number isn't handed out again.
        expect(board.chunks.map(c => c.id)).toEqual(Array.from({length: 16}, (_, i) => String(i + 2)))
        expect(board.chunks[0]!.tasks[0]).toMatchObject({id: 'GRE-1', aliases: ['FIX-1']})
        expect((await store.issue('greenhouse', 'MOT-5')).aliases).toEqual(['MOT-5'])
        expect((await store.createIssue('greenhouse', {title: 'next'})).id).toBe('GRE-140')
    })

    it('replacing never hands out a number again, and lets go of what pointed at the replaced issues', async () => {
        const owner = {name: 'skoll', owner: true}
        const shelves = (await store.createIssue('greenhouse', {title: 'Shelves'})).id
        await store.createIssue('greenhouse', {title: 'Jars'})
        await store.focus('greenhouse', shelves, {}, owner)
        await store.focusChunk('greenhouse', '1', {}, owner)
        const file = readRoadmap(JSON.stringify({chunks: [{id: 'new', title: 'New', tasks: [{id: 'lids', title: 'Lids', status: 'todo'}]}]}))
        const {board} = await store.importRoadmap('greenhouse', file, true)
        expect(board.chunks.map(c => c.id)).toEqual(['2'])
        expect(board.chunks[0]!.tasks.map(t => t.id)).toEqual(['GRE-3'])
        expect(await store.listSignals('greenhouse')).toEqual([])
        expect((await store.createIssue('greenhouse', {title: 'next'})).id).toBe('GRE-4')
    })
})
