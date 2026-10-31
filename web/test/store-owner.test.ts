// The owner: their name and things, their comments, the questions waiting on them, and the bell. The store, against a
// fresh database with the project `greenhouse` (store-setup.ts).
import {beforeEach, describe, expect, it} from 'vitest'
import {Store} from '../server/utils/store'
import {testDb} from './db'
import type {Actor} from '../server/utils/store'
import {failure, storeSetup} from './store-setup'

let store: Store

beforeEach(async () => {
    ({store} = await storeSetup())
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
        expect((await failure(() => store.readNotices({}))).status).toBe(400)
    })

    it('keeps what the owner has read on the comment, apart from seen, and clears only those read (ORR-785)', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        const agent = {name: 'claude', owner: false}
        const read = await store.createComment('greenhouse', id, {body: 'read'}, agent)
        const unread = await store.createComment('greenhouse', id, {body: 'unread'}, agent)
        expect((await store.notices()).some(n => n.read)).toBe(false)
        expect(await store.readNotices({ids: [read.id]})).toBe(1)
        expect(await store.readNotices({ids: [read.id]})).toBe(0)
        expect((await store.notices({list: 'inbox'})).map(n => [n.id, !!n.read]).sort()).toEqual([[read.id, true], [unread.id, false]].sort())
        expect(await store.clearNotices({read: true})).toBe(1)
        expect((await store.notices({list: 'inbox'})).map(n => n.id)).toEqual([unread.id])
    })

    it('leaves a question waiting when clearing the read ones', async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'A'})
        const asked = await store.createComment('greenhouse', id, {body: 'Which?', asks: 'decision'}, {name: 'claude', owner: false})
        await store.readNotices({ids: [asked.id]})
        expect(await store.clearNotices({read: true})).toBe(0)
        expect((await store.notices({list: 'waiting'})).map(n => n.id)).toEqual([asked.id])
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

    it("doesn't read a closed issue as waiting, and does again once it's reopened (ORR-640)", async () => {
        const {id} = await store.createIssue('greenhouse', {title: 'Vents'})
        await store.createComment('greenhouse', id, {body: 'Which?', asks: 'decision'}, {name: 'claude', owner: false})
        expect((await store.issue('greenhouse', id)).waiting).toBe('decision')
        for (const status of ['done', 'canceled']) {
            await store.updateIssue('greenhouse', id, {status}, {name: 'skoll', owner: true})
            expect((await store.issue('greenhouse', id)).waiting).toBeUndefined()
        }
        await store.updateIssue('greenhouse', id, {status: 'todo'}, {name: 'skoll', owner: true})
        expect((await store.issue('greenhouse', id)).waiting).toBe('decision')
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

describe('notice changes (ORR-803)', () => {
    const agent: Actor = {name: 'claude', owner: false, agent: true} as Actor

    it("lists status changes since a time, oldest first, only on issues in the bell", async () => {
        const told = (await store.createIssue('greenhouse', {title: 'Told', status: 'todo'})).id
        const quiet = (await store.createIssue('greenhouse', {title: 'Quiet', status: 'todo'})).id
        await store.createComment('greenhouse', told, {body: 'On it'}, agent)
        await store.updateIssue('greenhouse', told, {status: 'in-progress'}, agent)
        await store.updateIssue('greenhouse', told, {status: 'done'}, agent)
        await store.updateIssue('greenhouse', quiet, {status: 'done'}, agent)
        const changes = await store.noticeChanges({since: '2000-01-01T00:00:00.000Z'})
        expect(changes.map(c => [c.issue, c.before, c.after])).toEqual([[told, 'todo', 'in-progress'], [told, 'in-progress', 'done']])
        expect(changes[0]).toMatchObject({project: 'greenhouse', created_by: 'claude'})
        expect(await store.noticeChanges({since: '2999-01-01T00:00:00.000Z'})).toEqual([])
    })

    it('needs a time', async () => {
        expect((await failure(() => store.noticeChanges({}))).status).toBe(400)
        expect((await failure(() => store.noticeChanges({since: 'soon'}))).status).toBe(400)
    })
})
