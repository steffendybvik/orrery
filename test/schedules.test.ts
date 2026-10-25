import {beforeEach, describe, expect, it} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {openDb} from '../server/utils/db'
import {Schedules} from '../server/utils/schedules'
import {Store} from '../server/utils/store'

const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
let store: Store
let schedules: Schedules
let signals: Signal[]

beforeEach(() => {
    signals = []
    store = new Store(openDb(':memory:'), () => {}, signal => signals.push(signal))
    store.createProject({name: 'larder', key: 'LAR'})
    store.createChunk('larder', {title: 'Upkeep'})
    schedules = new Schedules(store)
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

const at = (iso: string) => new Date(iso)

describe('schedules', () => {
    it('work out their next run in their timezone', () => {
        const s = schedules.create('larder', {title: 'Groom', cron: '0 9 * * 1-5', timezone: 'Europe/Oslo'}, me)
        expect(s).toMatchObject({column: 'todo', enabled: true, skipOpen: true, ask: false, protected: true, runs: []})
        // 09:00 in Oslo is 07:00 or 08:00 UTC, depending on the season.
        expect(new Date(s.nextRun!).getUTCHours()).toBeGreaterThanOrEqual(7)
        expect(new Date(s.nextRun!).getUTCMinutes()).toBe(0)
    })

    it('refuse a bad cron, a bad zone, a past one-off, or both kinds of time', () => {
        expect(failure(() => schedules.create('larder', {title: 'x', cron: '0 9 * *'})).status).toBe(400)
        expect(failure(() => schedules.create('larder', {title: 'x', cron: '0 99 * * *'})).status).toBe(400)
        expect(failure(() => schedules.create('larder', {title: 'x', cron: '0 9 * * *', timezone: 'Mars/Olympus'})).status).toBe(400)
        expect(failure(() => schedules.create('larder', {title: 'x', at: '2001-01-01T00:00:00Z'})).status).toBe(400)
        expect(failure(() => schedules.create('larder', {title: 'x', cron: '0 9 * * *', at: '2099-01-01T00:00:00Z'})).status).toBe(400)
        expect(failure(() => schedules.create('larder', {title: 'x', cron: '0 9 * * *', chunk: '9'})).status).toBe(404)
    })

    it('make an issue when due, placed and marked, and run once after downtime', () => {
        const s = schedules.create('larder', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC', chunk: '1', priority: 'P2', labels: ['upkeep'], column: 'in-review'}, me)
        // A week late: it runs once, then waits for its next time.
        const late = new Date(new Date(s.nextRun!).getTime() + 7 * 86_400_000 + 60_000)
        expect(schedules.runDue(late)).toBe(1)
        expect(schedules.runDue(late)).toBe(0)
        const run = schedules.get('larder', s.id).runs[0]!
        expect(run.outcome).toBe('made')
        const issue = store.issue('larder', run.issue!)
        expect(issue).toMatchObject({chunk: '1', priority: 'P2', labels: ['upkeep'], status: 'in-review', schedule: s.id, createdBy: 'skoll', protected: true})
        expect(issue.title).toMatch(/^Groom · \w{3} \d+ \w{3}$/)
        expect(new Date(schedules.get('larder', s.id).nextRun!).getTime()).toBeGreaterThan(late.getTime())
    })

    it('skip while the last run is open, unless run by hand', () => {
        const s = schedules.create('larder', {title: 'Groom', cron: '* * * * *', timezone: 'UTC'}, me)
        schedules.runDue(at('2099-01-01T00:00:30Z'))
        schedules.runDue(at('2099-01-01T00:01:30Z'))
        const [skipped, made] = schedules.get('larder', s.id).runs
        expect(skipped).toMatchObject({outcome: 'skipped', note: `${made!.issue} from the last run isn't done yet`})
        expect(schedules.runNow('larder', s.id).outcome).toBe('made')
        store.updateIssue('larder', made!.issue!, {status: 'done'})
        store.updateIssue('larder', schedules.get('larder', s.id).runs[0]!.issue!, {status: 'done'})
        schedules.runDue(at('2099-01-01T00:02:30Z'))
        expect(schedules.get('larder', s.id).runs[0]!.outcome).toBe('made')
    })

    it("are claimed by one server only", () => {
        const s = schedules.create('larder', {title: 'Once', cron: '0 9 * * *', timezone: 'UTC'}, me)
        const other = new Schedules(store)
        const due = new Date(new Date(s.nextRun!).getTime() + 1000)
        expect(schedules.runDue(due) + other.runDue(due)).toBe(1)
    })

    it('ask the sessions only when the owner made them', () => {
        const mine = schedules.create('larder', {title: 'Mine', cron: '0 9 * * *', timezone: 'UTC', ask: true}, me)
        const theirs = schedules.create('larder', {title: 'Theirs', cron: '0 9 * * *', timezone: 'UTC', ask: true}, agent)
        schedules.runDue(new Date(new Date(mine.nextRun!).getTime() + 1000))
        const made = (id: number) => schedules.get('larder', id).runs[0]!.issue
        expect(signals.filter(s => s.kind === 'focus').map(s => [s.issue, s.protected])).toEqual([[made(mine.id), true], [made(theirs.id), false]])
    })

    it("wait for a session when nobody heard the ask", () => {
        const s = schedules.create('larder', {title: 'Mine', cron: '0 9 * * *', timezone: 'UTC', ask: true}, me)
        schedules.runNow('larder', s.id)
        const [waiting] = store.unheardScheduled('larder')
        expect(waiting?.issue).toBe(schedules.get('larder', s.id).runs[0]!.issue)
        store.delivered('larder', waiting!.id, 'larder 1')
        expect(store.unheardScheduled('larder')).toEqual([])
    })

    it('send a message instead of making an issue, the owner’s only', () => {
        const mine = schedules.create('larder', {kind: 'message', title: 'Check CI', notes: 'Is main green?', cron: '*/15 * * * *', timezone: 'UTC'}, me)
        const theirs = schedules.create('larder', {kind: 'message', title: 'Theirs', notes: 'hi', cron: '*/15 * * * *', timezone: 'UTC'}, agent)
        expect(failure(() => schedules.create('larder', {kind: 'message', title: 'Empty', cron: '0 9 * * *'})).status).toBe(400)
        expect(schedules.runNow('larder', mine.id)).toMatchObject({outcome: 'sent', note: 'nobody listening; the next session to connect gets it'})
        expect(schedules.runNow('larder', theirs.id).outcome).toBe('skipped')
        expect(store.listIssues('larder')).toEqual([])
        const [message] = signals.filter(s => s.kind === 'message')
        expect(message).toMatchObject({schedule: mine.id, note: 'Is main green?', protected: true})
        expect(message!.issue).toBeUndefined()
        expect(store.unheardScheduled('larder').map(s => s.id)).toEqual([message!.id])
        expect(schedules.update('larder', mine.id, {kind: 'issue'}).kind).toBe('issue')
    })

    it('go with their project', () => {
        const s = schedules.create('larder', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC'}, me)
        schedules.runNow('larder', s.id)
        store.deleteProject('larder', me)
        expect(schedules.list()).toEqual([])
        expect(store.db.prepare('SELECT count(*) AS n FROM schedule_runs').get()).toEqual({n: 0})
    })

    it('run a one-off once and then stop', () => {
        const s = schedules.create('larder', {title: 'Once', at: '2099-01-01T09:00:00Z'}, me)
        expect(schedules.runDue(at('2099-01-02T00:00:00Z'))).toBe(1)
        expect(schedules.get('larder', s.id)).toMatchObject({enabled: false, nextRun: undefined})
    })

    it('pause and resume, keeping the owner’s from agents', () => {
        const s = schedules.create('larder', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC'}, me)
        expect(schedules.update('larder', s.id, {enabled: false})).toMatchObject({enabled: false, nextRun: undefined})
        expect(schedules.update('larder', s.id, {enabled: true}).nextRun).toBeTruthy()
        expect(schedules.update('larder', s.id, {cron: '30 18 * * *'}).nextRun).toMatch(/T18:30/)
        expect(failure(() => schedules.delete('larder', s.id, agent)).status).toBe(403)
        schedules.delete('larder', s.id, me)
        expect(schedules.list('larder')).toEqual([])
    })
})
