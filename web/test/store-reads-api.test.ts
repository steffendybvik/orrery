import {beforeEach, describe, expect, it, vi} from 'vitest'
import {Store} from '../server/utils/store'
import {testDb} from './db'
import {failure} from './store-setup'

// The store's core reads ask the Rust API when it's set up (ORR-1162), so clearing, picking and handing out work read
// none of them from the database; with no API they're read here, as before.
const asked: string[] = []
let replies: Record<string, unknown> = {}
let writes: Record<string, unknown> = {}
vi.mock('../server/utils/api-router', () => ({
    readFromApi: async (path: string) => {
        asked.push(path)
        return replies[path]
    },
    writeToApi: async (_method: string, path: string) => path in writes ? {reply: writes[path]} : undefined,
}))

let store: Store

beforeEach(async () => {
    asked.length = 0
    replies = {}
    writes = {}
    store = new Store(testDb())
    await store.createProject({name: 'Greenhouse', key: 'GRE'})
    await store.createIssue('greenhouse', {title: 'Water the beds'})
})

describe("the store's reads through the Rust API (ORR-1162)", () => {
    it('reads the statuses, the owner, the people and the epics from the API', async () => {
        replies['/api/statuses'] = [{id: 'open', name: 'Open', kind: 'todo', color: null, position: 0}]
        replies['/api/owner'] = {name: 'ada', display: 'Ada', named: true}
        replies['/api/people'] = [{id: 'ada', name: 'Ada', role: 'owner', created_at: 'x'}]
        replies['/api/epics'] = [{id: 9, title: 'Spring'}]
        expect(await store.statuses()).toEqual(replies['/api/statuses'])
        expect(await store.ownerOf()).toEqual(replies['/api/owner'])
        expect(await store.people()).toEqual(replies['/api/people'])
        expect(await store.epics()).toEqual(replies['/api/epics'])
    })

    it("counts who's here, and who's a person, from the API's people, removed ones aside", async () => {
        replies['/api/people'] = [
            {id: 'ada', name: 'Ada', role: 'owner', created_at: 'x'},
            {id: 'bo', name: 'Bo', role: 'member', created_at: 'x', removed_at: 'y'},
        ]
        expect(await store.isShared()).toBe(false)
        expect(await store.isPerson('Bo')).toBe(true)
        expect(await store.isPerson('Cy')).toBe(false)
        expect(await store.isPerson('owner')).toBe(true)
        replies['/api/people'] = [...replies['/api/people'] as object[], {id: 'cy', name: 'Cy', role: 'member', created_at: 'x'}]
        expect(await store.isShared()).toBe(true)
        expect(await store.isPerson('Cy')).toBe(true)
    })

    it("reads a project's issues, with the filter as the route takes it, its milestones and an issue's comments", async () => {
        replies['/api/projects/greenhouse/issues'] = [{id: 'GRE-7'}]
        replies['/api/projects/greenhouse/issues?status=started&assignee=none'] = [{id: 'GRE-8'}]
        replies['/api/projects/greenhouse/milestones'] = [{id: '3'}]
        replies['/api/projects/greenhouse/issues/GRE-1/comments'] = [{id: 4, body: 'Done'}]
        expect(await store.listIssues('greenhouse')).toEqual([{id: 'GRE-7'}])
        expect(await store.listIssues('greenhouse', {status: 'started', assignee: 'none', label: undefined, q: ''})).toEqual([{id: 'GRE-8'}])
        expect(await store.listMilestones('greenhouse')).toEqual([{id: '3'}])
        expect(await store.listComments('greenhouse', 'GRE-1')).toEqual([{id: 4, body: 'Done'}])
    })

    it("says whose an issue's hand-outs are from the API's people and the board's members (ORR-1162)", async () => {
        replies['/api/people'] = [
            {id: 'ada', name: 'Ada', role: 'owner', created_at: 'x'},
            {id: 'bo', name: 'Bo', role: 'member', created_at: 'x'},
            {id: 'cy', name: 'Cy', role: 'member', created_at: 'x', removed_at: 'y'},
        ]
        replies['/api/owner'] = {name: 'ada', display: 'Ada', named: true}
        replies['/api/projects/greenhouse/members'] = [{person: 'bo', name: 'Bo', role: 'owner', created_at: 'x'}]
        expect(await store.whoseWork('greenhouse', 'bo')).toBe('bo')
        expect(await store.whoseWork('greenhouse', 'claude')).toBe('ada')
        expect(await store.whoseWork('greenhouse', 'cy')).toBeNull()
        expect(await store.whoseWork('greenhouse', null)).toBe('bo')
        replies['/api/projects/greenhouse/members'] = [{person: 'bo'}, {person: 'ada'}]
        expect(await store.whoseWork('greenhouse', null)).toBeNull()
    })

    it("reads each session's work from the API, naming the sessions only this server knows (ORR-1174)", async () => {
        const sessions = [{id: 'a', name: 'Ada', ids: ['a', 'old']}, {id: 'b', name: 'Bo'}]
        const path = `/api/projects/greenhouse/session-work?sessions=${encodeURIComponent(JSON.stringify(sessions))}`
        replies[path] = {a: {issues: [], signals: []}, b: {issues: [], signals: []}}
        expect(await store.sessionWork('greenhouse', sessions)).toEqual(replies[path])
    })

    it('asks the API whether the owner has a key and whether login stays on (ORR-1158)', async () => {
        replies['/api/auth/ways-in'] = {owner_has_key: true, stays_on: true}
        // Nobody's here and no key is in this database, so both say what the API does.
        expect(await store.ownerHasKey()).toBe(true)
        expect(await store.authStaysOn()).toBe(true)
        replies['/api/auth/ways-in'] = undefined
        expect(await store.ownerHasKey()).toBe(false)
        expect(await store.authStaysOn()).toBe(false)
    })

    it("hands a session the owner's unanswered comments as the API reads them (ORR-1161)", async () => {
        // None is in this database, so what's carried is the API's.
        replies['/api/projects/greenhouse/comments/unanswered'] = [{issue: 'GRE-1', body: 'Still waiting', created_by: 'owner', owned: true, assignee: null}]
        expect(await store.carryUnanswered('greenhouse', 'sess-1')).toBe(1)
        expect(await store.listSignals('greenhouse')).toEqual([expect.objectContaining({kind: 'comment', issue: 'GRE-1', note: 'Still waiting', target: 'sess-1'})])
        // A member's session asks for their own words too.
        expect(await store.carryUnanswered('greenhouse', 'sess-2', 'bo')).toBe(0)
        expect(asked).toContain('/api/projects/greenhouse/comments/unanswered?person=bo')
    })

    it('lists the projects from the API, without building their boards here (ORR-1174)', async () => {
        replies['/api/projects'] = [{id: 'greenhouse', name: 'Greenhouse', counts: {}}]
        expect(await store.listProjects()).toEqual(replies['/api/projects'])
    })

    it("reads a comment, and the issue it's on, from the API as it passes a relayed comment on (ORR-1174)", async () => {
        const notices: unknown[] = []
        const telling = new Store(testDb(), () => {}, () => {}, notice => notices.push(notice))
        await telling.createProject({name: 'Greenhouse', key: 'GRE'})
        replies['/api/projects/greenhouse/issues/GRE-9/comments/4'] = {id: 4, issue: 'GRE-9', body: 'From the API', created_by: 'claude'}
        replies['/api/projects/greenhouse/issues/GRE-9'] = {id: 'GRE-9', title: 'Only in the API', labels: [], assignee: 'claude'}
        expect(await telling.comment('greenhouse', 'GRE-9', 4)).toEqual(replies['/api/projects/greenhouse/issues/GRE-9/comments/4'])
        await telling.handOn('greenhouse', 'GRE-9', 4, {carry: false, notice: true}, {name: 'claude', owner: false})
        expect(notices).toEqual([expect.objectContaining({id: 4, body: 'From the API', project: 'greenhouse', title: 'Only in the API'})])
    })

    it('tells the projects sharing releases with one that changed, as the API names them (ORR-1174)', async () => {
        const told: string[] = []
        const telling = new Store(testDb(), project => told.push(project))
        await telling.createProject({name: 'Greenhouse', key: 'GRE'})
        told.length = 0
        replies['/api/projects/greenhouse/release-peers'] = ['shed']
        telling.changed('greenhouse')
        await vi.waitFor(() => expect(told).toEqual(['greenhouse', 'shed']))
    })

    it("leaves a signal and a relayed comment's notice to the API's outbox, and keeps its own without one (ORR-1174)", async () => {
        const rows = async () => (await store.all<{kind: string}>('SELECT kind FROM changes ORDER BY id')).map(r => r.kind)
        const before = (await rows()).length
        writes['/api/projects/greenhouse/signals'] = {id: 7, project: 'greenhouse', kind: 'message', delivered_to: []}
        writes['/api/projects/greenhouse/signals/7/receipts'] = {id: 7, project: 'greenhouse', kind: 'message', delivered_to: ['Ada']}
        await store.message('greenhouse', 1, 'Hi')
        await store.delivered('greenhouse', 7, 'Ada')
        replies['/api/projects/greenhouse/issues/GRE-1/comments/4'] = {id: 4, issue: 'GRE-1', body: 'Done', created_by: 'claude'}
        await store.handOn('greenhouse', 'GRE-1', 4, {carry: false, notice: true}, {name: 'claude', owner: false})
        expect((await rows()).slice(before).filter(kind => kind === 'signal' || kind === 'notice')).toEqual([])
        // With no API, the store writes the signal and its row here.
        delete writes['/api/projects/greenhouse/signals']
        await store.message('greenhouse', 1, 'Hi again')
        await vi.waitFor(async () => expect((await rows()).slice(before)).toContain('signal'))
    })

    it("reads this orrery's settings from the API (ORR-1174)", async () => {
        replies['/api/settings'] = {id: 'orr_api', tint: 'teal', statuses: []}
        expect(await store.settings()).toEqual(replies['/api/settings'])
    })

    it("checks a release the chat would make or change against the API's releases (ORR-1160)", async () => {
        await store.updateProject('greenhouse', {release_mode: 'own'})
        replies['/api/projects/greenhouse/releases'] = [{version: '2.0.0', branch: 'v2.0.0'}]
        expect(await store.checkRelease('greenhouse', {version: '2.1.0'})).toBeUndefined()
        expect(await store.checkRelease('greenhouse', {notes: 'Spring'}, '2.0.0')).toEqual({version: '2.0.0', branch: 'v2.0.0'})
        expect((await failure(() => store.checkRelease('greenhouse', {version: '2.0.0'}))).status).toBe(409)
        expect((await failure(() => store.checkRelease('greenhouse', {notes: 'X'}, '3.0.0'))).status).toBe(404)
        expect(await store.all('SELECT version FROM releases')).toEqual([])
    })

    it("reads a project's row and an issue's from the API for the store's helpers (ORR-1174)", async () => {
        replies['/api/projects/shed/row'] = {id: 'shed', name: 'Shed', focus_prompt: 'Tidy the shed first.', milestone_prompt: null, instructions: '[]', muted: '[]'}
        expect((await store.prompts('shed')).focus).toBe('Tidy the shed first.')
        replies['/api/projects/shed/issues/SHE-1/row'] = {project: 'shed', id: 'SHE-1', title: 'Oil the hinges', labels: '["chore"]', assignee: null}
        replies['/api/projects/shed/issues/SHE-1/workers'] = [{issue: 'SHE-1', started: false, worker: null}]
        expect(await store.workerOf('shed', 'SHE-1')).toBeNull()
        await expect(store.takenFrom('shed', 'SHE-1', 'me')).resolves.toBeNull()
    })

    it("checks the milestone and release a focus names through the API (ORR-1174)", async () => {
        replies['/api/projects/greenhouse/milestones/MLS-3/id'] = {id: '3'}
        replies['/api/projects/greenhouse/milestones/3/row'] = {project: 'greenhouse', id: '3', title: 'Spring'}
        replies['/api/projects/greenhouse/releases/2.0.0/row'] = {project: 'greenhouse', version: '2.0.0', branch: 'v2.0.0'}
        writes['/api/projects/greenhouse/signals'] = {id: 8, project: 'greenhouse', kind: 'focus', milestone: '3', release: '2.0.0', delivered_to: []}
        await store.focusMilestone('greenhouse', 'MLS-3', {release: '2.0.0'}, {name: 'owner', owner: true})
        expect(asked).toEqual(expect.arrayContaining(['/api/projects/greenhouse/milestones/3/row', '/api/projects/greenhouse/releases/2.0.0/row']))
        expect(await store.all('SELECT id FROM milestones')).toEqual([])
    })

    it("resolves an issue's id from the API for the store's helpers (ORR-1174)", async () => {
        replies['/api/projects/shed/issues/OLD-1/id'] = {id: 'SHE-1'}
        replies['/api/projects/shed/issues/SHE-1/row'] = {project: 'shed', id: 'SHE-1', title: 'Oil the hinges', labels: '[]', assignee: null}
        expect(await store.listActivity('shed', 'OLD-1')).toEqual([])
        expect(asked).toEqual(expect.arrayContaining(['/api/projects/shed/issues/OLD-1/id', '/api/projects/shed/issues/SHE-1/row']))
    })

    it('reads them from the database here with no API', async () => {
        expect((await store.statuses()).map(s => s.id)).toContain('todo')
        expect(await store.ownerOf()).toMatchObject({named: false})
        expect(await store.isShared()).toBe(false)
        expect((await store.listIssues('greenhouse')).map(i => i.title)).toEqual(['Water the beds'])
        expect((await store.listProjects()).map(p => p.id)).toEqual(['greenhouse'])
        expect(await store.listComments('greenhouse', 'GRE-1')).toEqual([])
        expect((await store.settings()).id).toMatch(/^orr_/)
        expect(asked).toEqual(expect.arrayContaining(['/api/statuses', '/api/owner', '/api/people', '/api/projects/greenhouse/issues']))
    })
})
