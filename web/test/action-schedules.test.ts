import {beforeEach, describe, expect, it} from 'vitest'
import type {OrreryEvent} from '#shared/happenings'
import type {Signal} from '#shared/roadmap'
import {Schedules, scheduleRunning} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
let store: Store
let schedules: Schedules
let signals: Signal[]
let heard: {event: OrreryEvent, cause?: number}[]

beforeEach(async () => {
    signals = []
    heard = []
    store = new Store(testDb(), () => {}, signal => signals.push(signal))
    store.happened = event => heard.push({event, cause: scheduleRunning.getStore()})
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.updateProject('greenhouse', {release_mode: 'own'})
    schedules = new Schedules(store)
})

/** Hands the schedules what happened since the last call, as the server does; says how many runs that made. */
async function pass(now = new Date()): Promise<number> {
    let ran = 0
    for (const {event, cause} of heard.splice(0)) ran += await schedules.hear(event, cause, now)
    return ran
}

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000)
const merged = {title: 'Merged PR closes its issue', kind: 'action', on: 'pr.merged', column: 'done', move_from: ['in-review']}
const inReview = async (title = 'Shelf labels', fields = {}) => await store.createIssue('greenhouse', {title, status: 'in-review', ...fields}, me)
const lastRun = async (id: number) => (await schedules.get('greenhouse', id)).runs[0]

describe('an action schedule', () => {
    it('moves the event\'s issue, says why in a comment, and wakes no session', async () => {
        const s = await schedules.create('greenhouse', {...merged, notes: 'Merged is shipped here.'}, me)
        const issue = await inReview()
        await pass()
        signals = []
        await store.systemEvent('greenhouse', issue.id, 'pr.merged')
        expect(await pass()).toBe(1)
        expect((await store.issue('greenhouse', issue.id)).column).toBe('done')
        expect(await lastRun(s.id)).toMatchObject({outcome: 'made', issue: issue.id, subject: issue.id, note: `moved ${issue.id} to Done`})
        const comments = await store.listComments('greenhouse', issue.id)
        expect(comments.at(-1)).toMatchObject({created_by: 'orrery'})
        expect(comments.at(-1)?.body).toContain('Moved from In review to Done by the schedule "Merged PR closes its issue". On pr.merged')
        expect(comments.at(-1)?.body).toContain('Merged is shipped here.')
        expect(signals).toEqual([])
    })

    it('sets off no schedule with what it does', async () => {
        const s = await schedules.create('greenhouse', merged, me)
        const told = await schedules.create('greenhouse', {title: 'Told', kind: 'message', notes: 'Closed.', on: 'issue.status', on_filter: {to: 'done'}}, me)
        const issue = await inReview()
        await pass()
        await store.systemEvent('greenhouse', issue.id, 'pr.merged')
        await pass()
        expect((await lastRun(s.id))?.outcome).toBe('made')
        expect(await pass()).toBe(0)
        expect((await schedules.get('greenhouse', told.id)).runs).toEqual([])
    })

    it('runs once per subject, and a skipped run leaves the next event free to move it', async () => {
        const s = await schedules.create('greenhouse', merged, me)
        const issue = await store.createIssue('greenhouse', {title: 'Not in review yet', status: 'todo'}, me)
        await pass()
        await store.systemEvent('greenhouse', issue.id, 'pr.merged')
        await pass()
        expect(await lastRun(s.id)).toMatchObject({outcome: 'skipped', note: `${issue.id} is in todo`})
        await store.updateIssue('greenhouse', issue.id, {status: 'in-review'}, me)
        await pass(later(2))
        await store.systemEvent('greenhouse', issue.id, 'pr.merged')
        await pass(later(2))
        expect((await store.issue('greenhouse', issue.id)).column).toBe('done')
        await store.updateIssue('greenhouse', issue.id, {status: 'in-review'}, me)
        await pass(later(4))
        await store.systemEvent('greenhouse', issue.id, 'pr.merged')
        expect(await pass(later(4))).toBe(0)
        expect((await store.issue('greenhouse', issue.id)).column).toBe('in-review')
    })

    it('passes over what waits on the owner: an open ask, a proposal', async () => {
        const s = await schedules.create('greenhouse', merged, me)
        const asking = await inReview('Which printer?')
        await store.createComment('greenhouse', asking.id, {body: 'Which one?', asks: 'decision'}, agent)
        await pass()
        await store.systemEvent('greenhouse', asking.id, 'pr.merged')
        await pass()
        expect(await lastRun(s.id)).toMatchObject({outcome: 'skipped', note: `${asking.id} waits on the owner`})
        expect((await store.issue('greenhouse', asking.id)).column).toBe('in-review')
        const proposal = await store.createIssue('greenhouse', {title: 'A greenhouse on Mars', proposal: 'pending'}, agent)
        await pass(later(2))
        const open = await schedules.create('greenhouse', {title: 'Anything open', kind: 'action', on: 'issue.labels', column: 'done'}, me)
        await store.updateIssue('greenhouse', proposal.id, {labels: ['far']}, me)
        await pass(later(2))
        expect(await lastRun(open.id)).toMatchObject({outcome: 'skipped', note: `${proposal.id} is a proposal`})
    })

    it('passes over an issue with another pull request still open, on a pull request\'s news', async () => {
        const s = await schedules.create('greenhouse', merged, me)
        const issue = await inReview()
        const pull = (number: number, merged: number) => store.db.run(`INSERT INTO pull_states (repo, number, names, title, url, branch, base, author, state, merged, created_at, updated_at, seen_at)
            VALUES ('me/shop', ?, ?, 'x', 'u', 'b', 'main', 'a', 'ready', ?, 'n', 'n', 'n')`, number, JSON.stringify([issue.id]), merged)
        await pull(1, 1)
        await pull(2, 0)
        await pass()
        await store.systemEvent('greenhouse', issue.id, 'pr.merged')
        await pass()
        expect(await lastRun(s.id)).toMatchObject({outcome: 'skipped', note: `${issue.id} has another pull request open`})
        await store.db.run('UPDATE pull_states SET merged = 1 WHERE number = 2')
        await store.systemEvent('greenhouse', issue.id, 'pr.merged')
        await pass(later(2))
        expect((await store.issue('greenhouse', issue.id)).column).toBe('done')
    })

    it('moves a release\'s issues, sub-issues included, and leaves another release\'s and a closed one alone', async () => {
        const s = await schedules.create('greenhouse', {title: 'Shipped closes', kind: 'action', on: 'release.shipped', column: 'done', move_from: ['in-review']}, me)
        await store.createRelease('greenhouse', {version: '1.0.0'}, me)
        await store.createRelease('greenhouse', {version: '1.1.0'}, me)
        const flat = await inReview('Flat', {release: '1.0.0'})
        const todo = await store.createIssue('greenhouse', {title: 'Not reviewed', status: 'todo', release: '1.0.0'}, me)
        const parent = await store.createIssue('greenhouse', {title: 'Parent', release: '1.0.0'}, me)
        const child = await inReview('Child', {parent: parent.id})
        const elsewhere = await inReview('Next release', {parent: parent.id, release: '1.1.0'})
        const canceled = await store.createIssue('greenhouse', {title: 'Dropped', status: 'canceled', release: '1.0.0'}, me)
        await pass()
        await store.updateRelease('greenhouse', '1.0.0', {shipped_on: '2026-10-30'}, me)
        await pass()
        const status = async (id: string) => (await store.issue('greenhouse', id)).column
        expect(await status(flat.id)).toBe('done')
        expect(await status(child.id)).toBe('done')
        expect(await status(todo.id)).toBe('todo')
        expect(await status(elsewhere.id)).toBe('in-review')
        expect(await status(canceled.id)).toBe('canceled')
        const run = await lastRun(s.id)
        expect(run).toMatchObject({outcome: 'made', subject: '1.0.0'})
        expect(run?.issue).toBeUndefined()
        expect(run?.note).toContain(`moved ${flat.id}, ${child.id} to Done`)
    })

    it('with no statuses named, moves only what\'s open', async () => {
        const s = await schedules.create('greenhouse', {title: 'Any open', kind: 'action', on: 'issue.labels', column: 'done'}, me)
        const open = await store.createIssue('greenhouse', {title: 'Open', status: 'todo'}, me)
        const closed = await store.createIssue('greenhouse', {title: 'Dropped', status: 'canceled'}, me)
        await pass()
        await store.updateIssue('greenhouse', closed.id, {labels: ['x']}, me)
        await pass()
        expect(await lastRun(s.id)).toMatchObject({outcome: 'skipped', note: `${closed.id} is in canceled`})
        await store.updateIssue('greenhouse', open.id, {labels: ['x']}, me)
        await pass(later(2))
        expect((await store.issue('greenhouse', open.id)).column).toBe('done')
    })

    it('is the owner\'s to make, on an event, with a status to move to', async () => {
        const failure = async (body: object, actor = me) => await schedules.create('greenhouse', body, actor).then(() => 0, (e: {statusCode: number}) => e.statusCode)
        expect(await failure(merged, agent)).toBe(403)
        expect(await failure({...merged, on: undefined, cron: '0 9 * * *'})).toBe(400)
        expect(await failure({title: 'x', kind: 'action', on: 'pr.merged'})).toBe(400)
        expect(await failure({...merged, move_from: ['nowhere']})).toBe(404)
        // Only an action schedule's status may be closed.
        expect(await failure({title: 'x', on: 'pr.merged', column: 'done'})).toBe(400)
        const s = await schedules.create('greenhouse', merged, me)
        await expect(schedules.update('greenhouse', s.id, {kind: 'issue'}, me)).rejects.toMatchObject({statusCode: 400})
        await expect(schedules.update('greenhouse', s.id, {cron: '0 9 * * *'}, me)).rejects.toMatchObject({statusCode: 400})
    })

    it('run by hand has no event to act on', async () => {
        const s = await schedules.create('greenhouse', merged, me)
        expect(await schedules.runNow('greenhouse', s.id, me)).toMatchObject({outcome: 'skipped', note: expect.stringMatching(/no event/)})
    })

    it('keeps its statuses when one is deleted', async () => {
        const status = await store.createStatus({name: 'QA', kind: 'started'}, me)
        const s = await schedules.create('greenhouse', {...merged, move_from: [status.id, 'started']}, me)
        await expect(store.deleteStatus(status.id, undefined, me)).rejects.toMatchObject({statusCode: 409})
        await store.deleteStatus(status.id, 'in-review', me)
        expect((await schedules.get('greenhouse', s.id)).move_from).toEqual(['in-review', 'started'])
    })
})
