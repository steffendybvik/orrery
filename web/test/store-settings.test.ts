// Settings: presets, statuses, the App settings and the terminal Watch opens. The store, against a fresh database with
// the project `greenhouse` (store-setup.ts).
import {beforeEach, describe, expect, it} from 'vitest'
import type {Actor,Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store

beforeEach(async () => {
    ({store} = await storeSetup())
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

    it('names the GitHub issues an issue came from, a bare number on the project\'s repo, found by any form (ORR-635)', async () => {
        const plain = await failure(() => store.createIssue('greenhouse', {title: 'Hinges', github_issues: [523]}))
        expect([plain.status, plain.message]).toEqual([400, expect.stringContaining('owner/name#523')])
        await store.updateProject('greenhouse', {repo: 'https://github.com/you/greenhouse'})
        const {id} = await store.createIssue('greenhouse', {title: 'Hinges', github_issues: [523, '#523', 'https://github.com/other/lib/issues/7']})
        expect((await store.issue('greenhouse', id)).github_issues).toEqual(['you/greenhouse#523', 'other/lib#7'])
        await store.createIssue('greenhouse', {title: 'Pins'})
        for (const form of ['523', '#523', 'You/Greenhouse#523', 'https://github.com/you/greenhouse/issues/523']) {
            expect((await store.listIssues('greenhouse', {github_issue: form})).map(i => i.id)).toEqual([id])
        }
        expect((await failure(() => store.updateIssue('greenhouse', id, {github_issues: ['ENG-1567']}))).status).toBe(400)
        expect((await failure(() => store.updateIssue('greenhouse', id, {github_issues: [0]}))).status).toBe(400)
        expect((await store.updateIssue('greenhouse', id, {github_issues: ['other/lib#7']})).github_issues).toEqual(['other/lib#7'])
        expect((await store.listActivity('greenhouse', id)).filter(e => e.field === 'github_issues').map(e => e.after))
            .toEqual(['["other/lib#7"]'])
        expect((await store.updateIssue('greenhouse', id, {github_issues: null})).github_issues).toEqual([])
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
