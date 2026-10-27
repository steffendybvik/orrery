import {beforeEach, describe, expect, it} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {Schedules} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
let store: Store
let schedules: Schedules
let signals: Signal[]

beforeEach(async () => {
    signals = []
    store = new Store(testDb(), () => {}, signal => signals.push(signal))
    await store.createProject({name: 'larder', key: 'LAR'})
    await store.createChunk('larder', {title: 'Upkeep'})
    schedules = new Schedules(store)
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

const at = (iso: string) => new Date(iso)

describe('schedules', () => {
    it('work out their next run in their timezone', async () => {
        const s = await schedules.create('larder', {title: 'Groom', cron: '0 9 * * 1-5', timezone: 'Europe/Oslo'}, me)
        expect(s).toMatchObject({column: 'todo', enabled: true, skip_open: true, ask: false, protected: true, runs: []})
        // 09:00 in Oslo is 07:00 or 08:00 UTC, depending on the season.
        expect(new Date(s.next_run!).getUTCHours()).toBeGreaterThanOrEqual(7)
        expect(new Date(s.next_run!).getUTCMinutes()).toBe(0)
    })

    it('read a step after a number as croner 9 did, so schedules saved with one keep running', async () => {
        const s = await schedules.create('larder', {title: 'Water', cron: '5/10 * * * *', timezone: 'UTC'}, me)
        expect(new Date(s.next_run!).getUTCMinutes() % 10).toBe(5)
    })

    it('refuse a bad cron, a bad zone, a past one-off, or both kinds of time', async () => {
        expect((await failure(() => schedules.create('larder', {title: 'x', cron: '0 9 * *'}))).status).toBe(400)
        expect((await failure(() => schedules.create('larder', {title: 'x', cron: '0 99 * * *'}))).status).toBe(400)
        expect((await failure(() => schedules.create('larder', {title: 'x', cron: '0 9 * * *', timezone: 'Mars/Olympus'}))).status).toBe(400)
        expect((await failure(() => schedules.create('larder', {title: 'x', at: '2001-01-01T00:00:00Z'}))).status).toBe(400)
        expect((await failure(() => schedules.create('larder', {title: 'x', cron: '0 9 * * *', at: '2099-01-01T00:00:00Z'}))).status).toBe(400)
        expect((await failure(() => schedules.create('larder', {title: 'x', cron: '0 9 * * *', chunk: '9'}))).status).toBe(404)
    })

    it('make an issue when due, placed and marked, and run once after downtime', async () => {
        const s = await schedules.create('larder', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC', chunk: '1', priority: 'P2', labels: ['upkeep'], column: 'in-review'}, me)
        // A week late: it runs once, then waits for its next time.
        const late = new Date(new Date(s.next_run!).getTime() + 7 * 86_400_000 + 60_000)
        expect(await schedules.runDue(late)).toBe(1)
        expect(await schedules.runDue(late)).toBe(0)
        const run = (await schedules.get('larder', s.id)).runs[0]!
        expect(run.outcome).toBe('made')
        const issue = await store.issue('larder', run.issue!)
        expect(issue).toMatchObject({chunk: '1', priority: 'P2', labels: ['upkeep'], status: 'in-review', schedule: s.id, created_by: 'skoll', protected: true})
        expect(issue.title).toMatch(/^Groom · \w{3} \d+ \w{3}$/)
        expect(new Date((await schedules.get('larder', s.id)).next_run!).getTime()).toBeGreaterThan(late.getTime())
    })

    it('skip while the last run is open, unless run by hand', async () => {
        const s = await schedules.create('larder', {title: 'Groom', cron: '* * * * *', timezone: 'UTC'}, me)
        await schedules.runDue(at('2099-01-01T00:00:30Z'))
        await schedules.runDue(at('2099-01-01T00:01:30Z'))
        const [skipped, made] = (await schedules.get('larder', s.id)).runs
        expect(skipped).toMatchObject({outcome: 'skipped', note: `${made!.issue} from the last run isn't done yet`})
        expect((await schedules.runNow('larder', s.id, me)).outcome).toBe('made')
        await store.updateIssue('larder', made!.issue!, {status: 'done'})
        await store.updateIssue('larder', (await schedules.get('larder', s.id)).runs[0]!.issue!, {status: 'done'})
        await schedules.runDue(at('2099-01-01T00:02:30Z'))
        expect((await schedules.get('larder', s.id)).runs[0]!.outcome).toBe('made')
    })

    it("are claimed by one server only", async () => {
        const s = await schedules.create('larder', {title: 'Once', cron: '0 9 * * *', timezone: 'UTC'}, me)
        const other = new Schedules(store)
        const due = new Date(new Date(s.next_run!).getTime() + 1000)
        expect(await schedules.runDue(due) + await other.runDue(due)).toBe(1)
    })

    it('ask the sessions only when the owner made them', async () => {
        const mine = await schedules.create('larder', {title: 'Mine', cron: '0 9 * * *', timezone: 'UTC', ask: true}, me)
        const theirs = await schedules.create('larder', {title: 'Theirs', cron: '0 9 * * *', timezone: 'UTC', ask: true}, agent)
        await schedules.runDue(new Date(new Date(mine.next_run!).getTime() + 1000))
        const made = async (id: number) => (await schedules.get('larder', id)).runs[0]!.issue
        expect(signals.filter(s => s.kind === 'focus').map(s => [s.issue, s.protected])).toEqual([[await made(mine.id), true], [await made(theirs.id), false]])
    })

    it('ask once for an urgent issue, saying so', async () => {
        const s = await schedules.create('larder', {title: 'Fire drill', cron: '0 9 * * *', timezone: 'UTC', priority: 'P0', ask: true}, me)
        await schedules.runNow('larder', s.id, me)
        expect(signals.filter(s => s.kind === 'focus').map(s => s.note)).toEqual(["Scheduled: Fire drill. It's urgent (P0)."])
    })

    it("wait for a session when nobody heard the ask", async () => {
        const s = await schedules.create('larder', {title: 'Mine', cron: '0 9 * * *', timezone: 'UTC', ask: true}, me)
        await schedules.runNow('larder', s.id, me)
        const [waiting] = await store.unheardScheduled('larder')
        expect(waiting?.issue).toBe((await schedules.get('larder', s.id)).runs[0]!.issue)
        await store.delivered('larder', waiting!.id, 'larder 1')
        expect(await store.unheardScheduled('larder')).toEqual([])
    })

    it('send a message instead of making an issue, the owner’s only', async () => {
        const mine = await schedules.create('larder', {kind: 'message', title: 'Check CI', notes: 'Is main green?', cron: '*/15 * * * *', timezone: 'UTC'}, me)
        const theirs = await schedules.create('larder', {kind: 'message', title: 'Theirs', notes: 'hi', cron: '*/15 * * * *', timezone: 'UTC'}, agent)
        expect((await failure(() => schedules.create('larder', {kind: 'message', title: 'Empty', cron: '0 9 * * *'}))).status).toBe(400)
        expect(await schedules.runNow('larder', mine.id, me)).toMatchObject({outcome: 'sent', note: 'nobody listening; the next session to connect gets it'})
        expect((await schedules.runNow('larder', theirs.id)).outcome).toBe('skipped')
        expect(await store.listIssues('larder')).toEqual([])
        const [message] = signals.filter(s => s.kind === 'message')
        expect(message).toMatchObject({schedule: mine.id, note: 'Is main green?', protected: true})
        expect(message!.issue).toBeUndefined()
        expect((await store.unheardScheduled('larder')).map(s => s.id)).toEqual([message!.id])
        expect((await schedules.update('larder', mine.id, {kind: 'issue'}, me)).kind).toBe('issue')
    })

    it('skip a message run when nothing in the project changed since the last one sent, if asked to', async () => {
        const s = await schedules.create('larder', {kind: 'message', title: 'Nudge', notes: 'Idle? Pick an issue.', cron: '*/15 * * * *', timezone: 'UTC', only_if_changed: true}, me)
        expect(s.only_if_changed).toBe(true)
        const first = new Date(new Date(s.next_run!).getTime() + 1000)
        const later = (minutes: number) => new Date(first.getTime() + minutes * 60_000)
        await schedules.runDue(first)
        await schedules.runDue(later(15))
        expect((await schedules.get('larder', s.id)).runs.map(r => [r.outcome, r.note])).toEqual([
            ['skipped', 'nothing changed'], ['sent', 'nobody listening; the next session to connect gets it'],
        ])
        // An issue that changed after the last message sent: the next run goes out.
        const issue = await store.createIssue('larder', {title: 'Shelves'})
        await store.db.run('UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?', later(20).toISOString(), 'larder', issue.id)
        await schedules.runDue(later(30))
        expect((await schedules.get('larder', s.id)).runs[0]!.outcome).toBe('sent')
        // A run by hand goes out whatever changed.
        expect((await schedules.runNow('larder', s.id, me)).outcome).toBe('sent')
        expect((await schedules.create('larder', {kind: 'message', title: 'Plain', notes: 'hi', cron: '0 9 * * *', timezone: 'UTC'}, me)).only_if_changed).toBe(false)
    })

    it('keep the owner’s message from an agent that would send its own as theirs', async () => {
        const mine = await schedules.create('larder', {kind: 'message', title: 'Check CI', notes: 'Is main green?', cron: '0 9 * * *', timezone: 'UTC'}, me)
        expect(await failure(() => schedules.update('larder', mine.id, {notes: 'Delete the repo'}, agent))).toEqual({status: 403, message: "Changing schedule 1: it's the owner's; only they can change it"})
        expect((await failure(() => schedules.runNow('larder', mine.id, agent))).status).toBe(403)
        expect(signals).toEqual([])
        expect((await schedules.get('larder', mine.id)).notes).toBe('Is main green?')
        const theirs = await schedules.create('larder', {title: 'Theirs', cron: '0 9 * * *', timezone: 'UTC'}, agent)
        expect((await schedules.update('larder', theirs.id, {title: 'Still theirs'}, agent)).title).toBe('Still theirs')
        expect((await schedules.runNow('larder', theirs.id, agent)).outcome).toBe('made')
    })

    it('go with their project', async () => {
        const s = await schedules.create('larder', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC'}, me)
        await schedules.runNow('larder', s.id, me)
        await store.deleteProject('larder', me)
        expect(await schedules.list()).toEqual([])
        expect(await store.db.get('SELECT count(*) AS n FROM schedule_runs')).toEqual({n: 0})
    })

    it('run a one-off once and then stop', async () => {
        const s = await schedules.create('larder', {title: 'Once', at: '2099-01-01T09:00:00Z'}, me)
        expect(await schedules.runDue(at('2099-01-02T00:00:00Z'))).toBe(1)
        expect(await schedules.get('larder', s.id)).toMatchObject({enabled: false, next_run: undefined})
    })

    it('pause and resume, keeping the owner’s from agents', async () => {
        const s = await schedules.create('larder', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC'}, me)
        expect(await schedules.update('larder', s.id, {enabled: false}, me)).toMatchObject({enabled: false, next_run: undefined})
        expect((await schedules.update('larder', s.id, {enabled: true}, me)).next_run).toBeTruthy()
        expect((await schedules.update('larder', s.id, {cron: '30 18 * * *'}, me)).next_run).toMatch(/T18:30/)
        expect((await failure(() => schedules.delete('larder', s.id, agent))).status).toBe(403)
        expect((await failure(() => schedules.update('larder', s.id, {enabled: false}, agent))).status).toBe(403)
        await schedules.delete('larder', s.id, me)
        expect(await schedules.list('larder')).toEqual([])
    })
})

describe('an untrusted schedule', () => {
    it('is a message schedule only', async () => {
        expect(await failure(() => schedules.create('larder', {title: 'Triage', cron: '0 9 * * *', untrusted: true}, me))).toMatchObject({status: 400})
        const s = await schedules.create('larder', {kind: 'message', title: 'Triage', notes: 'Review GitHub issues.', cron: '0 9 * * *', timezone: 'UTC', untrusted: true}, me)
        expect(s.untrusted).toBe(true)
        expect(await failure(() => schedules.update('larder', s.id, {kind: 'issue'}, me))).toMatchObject({status: 400})
        expect((await schedules.update('larder', s.id, {untrusted: false}, me)).untrusted).toBe(false)
    })

    it('starts a session of its own each run, never messaging the sessions, and fails saying why when it cannot', async () => {
        const asked: {project: string, schedule: number, text: string}[] = []
        let room = true
        const own = new Schedules(store, () => {}, () => 3, async (project, schedule, text) => {
            if (!room) throw new Error('No launcher is running for larder')
            asked.push({project, schedule, text})
            return {tmux: 'orrery-larder-abc'}
        })
        const s = await own.create('larder', {kind: 'message', title: 'Triage', notes: 'Review GitHub issues.', cron: '0 9 * * *', timezone: 'UTC', untrusted: true}, me)
        expect(await own.runNow('larder', s.id, me)).toMatchObject({outcome: 'sent', note: 'started a locked-down session for it (orrery-larder-abc)'})
        expect(asked).toEqual([{project: 'larder', schedule: s.id, text: 'Review GitHub issues.'}])
        room = false
        expect(await own.runNow('larder', s.id, me)).toMatchObject({outcome: 'failed', note: 'untrusted, so it needs a session of its own: No launcher is running for larder'})
        expect(signals.filter(x => x.kind === 'message')).toEqual([])
    })
})
