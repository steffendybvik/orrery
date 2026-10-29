// Proposals: put up, decided, chosen between, and waiting in the bell. The store, against a fresh database with the
// project `greenhouse` (store-setup.ts).
import {beforeEach, describe, expect, it} from 'vitest'
import {total} from '#shared/roadmap'
import type {Actor,Store} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store

beforeEach(async () => {
    ({store} = await storeSetup())
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

    it('clear one by one, leaving the proposal pending, until it is put up again', async () => {
        const agent = {name: 'claude', owner: false}
        const owner = {name: 'skoll', owner: true}
        const {id} = await store.createIssue('greenhouse', {title: 'Dark mode', notes: 'Why and how', proposal: 'pending'}, agent)
        const {id: other} = await store.createIssue('greenhouse', {title: 'B'})
        const comment = await store.createComment('greenhouse', other, {body: 'Ship it?', asks: 'decision'}, agent)
        expect(await store.clearNotices({ids: [comment.id], proposals: [{project: 'greenhouse', issue: id}, {project: 'greenhouse', issue: other}]})).toBe(2)
        for (const list of ['bell', 'waiting', 'inbox'] as const) expect(await store.notices({list})).toEqual([])
        expect((await store.notices({list: 'cleared'})).map(n => [n.issue, n.cleared, !!n.proposal])).toEqual([[other, true, false], [id, true, true]])
        expect((await store.issue('greenhouse', id)).proposal).toBe('pending')
        // Again changes nothing; on a later page of Cleared it isn't listed twice.
        expect(await store.clearNotices({proposals: [{project: 'greenhouse', issue: id}]})).toBe(0)
        expect((await store.notices({list: 'cleared', before: comment.id})).map(n => n.issue)).toEqual([])
        await store.decide('greenhouse', id, {decision: 'changes', note: 'Shorter'}, owner)
        expect((await store.notices({list: 'cleared'})).map(n => n.issue)).toEqual([other])
        await new Promise(resolve => setTimeout(resolve, 5))
        await store.updateIssue('greenhouse', id, {proposal: 'pending'}, agent)
        expect((await store.notices()).map(n => n.issue)).toEqual([id])
        expect((await failure(() => store.clearNotices({proposals: [{project: 'greenhouse'}]}))).status).toBe(400)
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
