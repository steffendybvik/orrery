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
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.createChunk('greenhouse', {title: 'Upkeep'})
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
        const s = await schedules.create('greenhouse', {title: 'Groom', cron: '0 9 * * 1-5', timezone: 'Europe/Oslo'}, me)
        expect(s).toMatchObject({column: 'todo', enabled: true, skip_open: true, ask: false, protected: true, runs: []})
        // 09:00 in Oslo is 07:00 or 08:00 UTC, depending on the season.
        expect(new Date(s.next_run!).getUTCHours()).toBeGreaterThanOrEqual(7)
        expect(new Date(s.next_run!).getUTCMinutes()).toBe(0)
    })

    it('read a step after a number as croner 9 did, so schedules saved with one keep running', async () => {
        const s = await schedules.create('greenhouse', {title: 'Water', cron: '5/10 * * * *', timezone: 'UTC'}, me)
        expect(new Date(s.next_run!).getUTCMinutes() % 10).toBe(5)
    })

    it('refuse a bad cron, a bad zone, a past one-off, or both kinds of time', async () => {
        expect((await failure(() => schedules.create('greenhouse', {title: 'x', cron: '0 9 * *'}))).status).toBe(400)
        expect((await failure(() => schedules.create('greenhouse', {title: 'x', cron: '0 99 * * *'}))).status).toBe(400)
        expect((await failure(() => schedules.create('greenhouse', {title: 'x', cron: '0 9 * * *', timezone: 'Mars/Olympus'}))).status).toBe(400)
        expect((await failure(() => schedules.create('greenhouse', {title: 'x', at: '2001-01-01T00:00:00Z'}))).status).toBe(400)
        expect((await failure(() => schedules.create('greenhouse', {title: 'x', cron: '0 9 * * *', at: '2099-01-01T00:00:00Z'}))).status).toBe(400)
        expect((await failure(() => schedules.create('greenhouse', {title: 'x', cron: '0 9 * * *', chunk: '9'}))).status).toBe(404)
    })

    it('make an issue when due, placed and marked, and run once after downtime', async () => {
        const s = await schedules.create('greenhouse', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC', chunk: '1', priority: 'P2', labels: ['upkeep'], column: 'in-review'}, me)
        // A week late: it runs once, then waits for its next time.
        const late = new Date(new Date(s.next_run!).getTime() + 7 * 86_400_000 + 60_000)
        expect(await schedules.runDue(late)).toBe(1)
        expect(await schedules.runDue(late)).toBe(0)
        const run = (await schedules.get('greenhouse', s.id)).runs[0]!
        expect(run.outcome).toBe('made')
        const issue = await store.issue('greenhouse', run.issue!)
        expect(issue).toMatchObject({chunk: '1', priority: 'P2', labels: ['upkeep'], status: 'in-review', schedule: s.id, created_by: 'skoll', protected: true})
        expect(issue.title).toMatch(/^Groom · \w{3} \d+ \w{3}$/)
        expect(new Date((await schedules.get('greenhouse', s.id)).next_run!).getTime()).toBeGreaterThan(late.getTime())
    })

    it('skip while the last run is open, unless run by hand', async () => {
        const s = await schedules.create('greenhouse', {title: 'Groom', cron: '* * * * *', timezone: 'UTC'}, me)
        await schedules.runDue(at('2099-01-01T00:00:30Z'))
        await schedules.runDue(at('2099-01-01T00:01:30Z'))
        const [skipped, made] = (await schedules.get('greenhouse', s.id)).runs
        expect(skipped).toMatchObject({outcome: 'skipped', note: `${made!.issue} from the last run isn't done yet`})
        expect((await schedules.runNow('greenhouse', s.id, me)).outcome).toBe('made')
        await store.updateIssue('greenhouse', made!.issue!, {status: 'done'})
        await store.updateIssue('greenhouse', (await schedules.get('greenhouse', s.id)).runs[0]!.issue!, {status: 'done'})
        await schedules.runDue(at('2099-01-01T00:02:30Z'))
        expect((await schedules.get('greenhouse', s.id)).runs[0]!.outcome).toBe('made')
    })

    it("are claimed by one server only", async () => {
        const s = await schedules.create('greenhouse', {title: 'Once', cron: '0 9 * * *', timezone: 'UTC'}, me)
        const other = new Schedules(store)
        const due = new Date(new Date(s.next_run!).getTime() + 1000)
        expect(await schedules.runDue(due) + await other.runDue(due)).toBe(1)
    })

    it('ask the sessions only when the owner made them', async () => {
        const mine = await schedules.create('greenhouse', {title: 'Mine', cron: '0 9 * * *', timezone: 'UTC', ask: true}, me)
        const theirs = await schedules.create('greenhouse', {title: 'Theirs', cron: '0 9 * * *', timezone: 'UTC', ask: true}, agent)
        await schedules.runDue(new Date(new Date(mine.next_run!).getTime() + 1000))
        const made = async (id: number) => (await schedules.get('greenhouse', id)).runs[0]!.issue
        expect(signals.filter(s => s.kind === 'focus').map(s => [s.issue, s.protected])).toEqual([[await made(mine.id), true], [await made(theirs.id), false]])
    })

    it('ask once for an urgent issue, saying so', async () => {
        const s = await schedules.create('greenhouse', {title: 'Fire drill', cron: '0 9 * * *', timezone: 'UTC', priority: 'P0', ask: true}, me)
        await schedules.runNow('greenhouse', s.id, me)
        expect(signals.filter(s => s.kind === 'focus').map(s => s.note)).toEqual(["Scheduled: Fire drill. It's urgent (P0)."])
    })

    it("wait for a session when nobody heard the ask", async () => {
        const s = await schedules.create('greenhouse', {title: 'Mine', cron: '0 9 * * *', timezone: 'UTC', ask: true}, me)
        await schedules.runNow('greenhouse', s.id, me)
        const [waiting] = await store.unheardScheduled('greenhouse')
        expect(waiting?.issue).toBe((await schedules.get('greenhouse', s.id)).runs[0]!.issue)
        await store.delivered('greenhouse', waiting!.id, 'greenhouse 1')
        expect(await store.unheardScheduled('greenhouse')).toEqual([])
    })

    it('send a message instead of making an issue, the owner’s only', async () => {
        const mine = await schedules.create('greenhouse', {kind: 'message', title: 'Check CI', notes: 'Is main green?', cron: '*/15 * * * *', timezone: 'UTC'}, me)
        const theirs = await schedules.create('greenhouse', {kind: 'message', title: 'Theirs', notes: 'hi', cron: '*/15 * * * *', timezone: 'UTC'}, agent)
        expect((await failure(() => schedules.create('greenhouse', {kind: 'message', title: 'Empty', cron: '0 9 * * *'}))).status).toBe(400)
        expect(await schedules.runNow('greenhouse', mine.id, me)).toMatchObject({outcome: 'sent', note: 'nobody listening; the next session to connect gets it'})
        expect((await schedules.runNow('greenhouse', theirs.id)).outcome).toBe('skipped')
        expect(await store.listIssues('greenhouse')).toEqual([])
        const [message] = signals.filter(s => s.kind === 'message')
        expect(message).toMatchObject({schedule: mine.id, note: 'Is main green?', protected: true})
        expect(message!.issue).toBeUndefined()
        expect((await store.unheardScheduled('greenhouse')).map(s => s.id)).toEqual([message!.id])
        expect((await schedules.update('greenhouse', mine.id, {kind: 'issue'}, me)).kind).toBe('issue')
    })

    it('skip a message run when nothing in the project changed since the last one sent, if asked to', async () => {
        const s = await schedules.create('greenhouse', {kind: 'message', title: 'Nudge', notes: 'Idle? Pick an issue.', cron: '*/15 * * * *', timezone: 'UTC', only_if_changed: true}, me)
        expect(s.only_if_changed).toBe(true)
        const first = new Date(new Date(s.next_run!).getTime() + 1000)
        const later = (minutes: number) => new Date(first.getTime() + minutes * 60_000)
        await schedules.runDue(first)
        await schedules.runDue(later(15))
        expect((await schedules.get('greenhouse', s.id)).runs.map(r => [r.outcome, r.note])).toEqual([
            ['skipped', 'nothing changed'], ['sent', 'nobody listening; the next session to connect gets it'],
        ])
        // An issue that changed after the last message sent: the next run goes out.
        const issue = await store.createIssue('greenhouse', {title: 'Shelves'})
        await store.db.run('UPDATE issues SET updated_at = ? WHERE project = ? AND id = ?', later(20).toISOString(), 'greenhouse', issue.id)
        await schedules.runDue(later(30))
        expect((await schedules.get('greenhouse', s.id)).runs[0]!.outcome).toBe('sent')
        // A run by hand goes out whatever changed.
        expect((await schedules.runNow('greenhouse', s.id, me)).outcome).toBe('sent')
        expect((await schedules.create('greenhouse', {kind: 'message', title: 'Plain', notes: 'hi', cron: '0 9 * * *', timezone: 'UTC'}, me)).only_if_changed).toBe(false)
    })

    it('keep the owner’s message from an agent that would send its own as theirs', async () => {
        const mine = await schedules.create('greenhouse', {kind: 'message', title: 'Check CI', notes: 'Is main green?', cron: '0 9 * * *', timezone: 'UTC'}, me)
        expect(await failure(() => schedules.update('greenhouse', mine.id, {notes: 'Delete the repo'}, agent))).toEqual({status: 403, message: "Changing schedule 1: it's the owner's; only they can change it"})
        expect((await failure(() => schedules.runNow('greenhouse', mine.id, agent))).status).toBe(403)
        expect(signals).toEqual([])
        expect((await schedules.get('greenhouse', mine.id)).notes).toBe('Is main green?')
        const theirs = await schedules.create('greenhouse', {title: 'Theirs', cron: '0 9 * * *', timezone: 'UTC'}, agent)
        expect((await schedules.update('greenhouse', theirs.id, {title: 'Still theirs'}, agent)).title).toBe('Still theirs')
        expect((await schedules.runNow('greenhouse', theirs.id, agent)).outcome).toBe('made')
        // The owner changing an agent's schedule, into a message one even, leaves it the agent's: its runs are skipped.
        const changed = await schedules.update('greenhouse', theirs.id, {kind: 'message', notes: 'Pick up Todo.'}, me)
        expect(changed).toMatchObject({created_by: agent.name, protected: false})
        expect((await schedules.runNow('greenhouse', theirs.id, me)).outcome).toBe('skipped')
        // Made theirs, once they've read it, it reaches the sessions, and agents can't change it.
        const mine2 = await schedules.adopt('greenhouse', theirs.id, me, changed.updated_at)
        expect(mine2).toMatchObject({created_by: me.name, protected: true})
        expect((await schedules.runNow('greenhouse', theirs.id, me)).outcome).toBe('sent')
        expect((await failure(() => schedules.update('greenhouse', theirs.id, {notes: 'Delete the repo'}, agent))).status).toBe(403)
    })

    it("become the owner's only when they make them theirs, having read what they say now (ORR-456)", async () => {
        const theirs = await schedules.create('greenhouse', {kind: 'message', title: 'Nudge', notes: 'Pick up Todo.', cron: '0 9 * * *', timezone: 'UTC'}, agent)
        // A pause, a rename or a new time leaves it the agent's.
        for (const change of [{enabled: false}, {title: 'Morning nudge'}, {cron: '0 10 * * *'}, {enabled: true}]) {
            expect(await schedules.update('greenhouse', theirs.id, change, me)).toMatchObject({created_by: agent.name, protected: false})
        }
        expect((await failure(() => schedules.adopt('greenhouse', theirs.id, agent))).status).toBe(403)
        const read = await schedules.get('greenhouse', theirs.id)
        // The agent changes what it says after the owner read it: making it theirs is refused until they read it again.
        await new Promise(resolve => setTimeout(resolve, 5))
        const changed = await schedules.update('greenhouse', theirs.id, {notes: 'Delete the repo.'}, agent)
        expect((await failure(() => schedules.adopt('greenhouse', theirs.id, me, read.updated_at))).status).toBe(409)
        expect(await schedules.adopt('greenhouse', theirs.id, me, changed.updated_at)).toMatchObject({created_by: me.name, protected: true, notes: 'Delete the repo.'})
        // Theirs already, it stays as it is.
        expect((await schedules.adopt('greenhouse', theirs.id, me, 'anything')).protected).toBe(true)
    })

    it('go with their project', async () => {
        const s = await schedules.create('greenhouse', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC'}, me)
        await schedules.runNow('greenhouse', s.id, me)
        await store.deleteProject('greenhouse', me)
        expect(await schedules.list()).toEqual([])
        expect(await store.db.get('SELECT count(*) AS n FROM schedule_runs')).toEqual({n: 0})
    })

    it('run now instead of the next run, which is skipped', async () => {
        const s = await schedules.create('greenhouse', {title: 'Groom', cron: '0 9 * * *', timezone: 'Europe/Oslo'}, me)
        const run = await schedules.runNow('greenhouse', s.id, me, true)
        expect(run).toMatchObject({outcome: 'made', note: expect.stringMatching(/^instead of \w{3} \d+ \w{3} 09:00$/)})
        const after = await schedules.get('greenhouse', s.id)
        expect(new Date(after.next_run!).getTime() - new Date(s.next_run!).getTime()).toBeGreaterThanOrEqual(23 * 3_600_000)
        expect(await schedules.runDue(new Date(new Date(s.next_run!).getTime() + 1000))).toBe(0)
        // A one-off run instead is done; a paused one has no next run to skip.
        const once = await schedules.create('greenhouse', {title: 'Once', at: '2099-01-01T09:00:00Z'}, me)
        await schedules.runNow('greenhouse', once.id, me, true)
        expect(await schedules.get('greenhouse', once.id)).toMatchObject({enabled: false, next_run: undefined})
        expect(await failure(() => schedules.runNow('greenhouse', once.id, me, true))).toEqual({status: 409, message: `Running schedule ${once.id} instead of its next run: it has none, so run it now`})
        expect((await failure(() => schedules.runNow('greenhouse', s.id, agent, true))).status).toBe(403)
    })

    it('run a one-off once and then stop', async () => {
        const s = await schedules.create('greenhouse', {title: 'Once', at: '2099-01-01T09:00:00Z'}, me)
        expect(await schedules.runDue(at('2099-01-02T00:00:00Z'))).toBe(1)
        expect(await schedules.get('greenhouse', s.id)).toMatchObject({enabled: false, next_run: undefined})
    })

    it('pause and resume, keeping the owner’s from agents', async () => {
        const s = await schedules.create('greenhouse', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC'}, me)
        expect(await schedules.update('greenhouse', s.id, {enabled: false}, me)).toMatchObject({enabled: false, next_run: undefined})
        expect((await schedules.update('greenhouse', s.id, {enabled: true}, me)).next_run).toBeTruthy()
        expect((await schedules.update('greenhouse', s.id, {cron: '30 18 * * *'}, me)).next_run).toMatch(/T18:30/)
        expect((await failure(() => schedules.delete('greenhouse', s.id, agent))).status).toBe(403)
        expect((await failure(() => schedules.update('greenhouse', s.id, {enabled: false}, agent))).status).toBe(403)
        await schedules.delete('greenhouse', s.id, me)
        expect(await schedules.list('greenhouse')).toEqual([])
    })
})

describe('an untrusted schedule', () => {
    it('is a message schedule only', async () => {
        expect(await failure(() => schedules.create('greenhouse', {title: 'Triage', cron: '0 9 * * *', untrusted: true}, me))).toMatchObject({status: 400})
        const s = await schedules.create('greenhouse', {kind: 'message', title: 'Triage', notes: 'Review GitHub issues.', cron: '0 9 * * *', timezone: 'UTC', untrusted: true}, me)
        expect(s.untrusted).toBe(true)
        expect(await failure(() => schedules.update('greenhouse', s.id, {kind: 'issue'}, me))).toMatchObject({status: 400})
        expect((await schedules.update('greenhouse', s.id, {untrusted: false}, me)).untrusted).toBe(false)
    })

    it('starts a session of its own each run, never messaging the sessions, and fails saying why when it cannot', async () => {
        const asked: {project: string, schedule: number, text: string}[] = []
        let room = true
        const own = new Schedules(store, {listening: () => 3, startUntrusted: async (project, schedule, text) => {
            if (!room) throw new Error('No launcher is running for greenhouse')
            asked.push({project, schedule, text})
            return {tmux: 'orrery-greenhouse-abc'}
        }})
        const s = await own.create('greenhouse', {kind: 'message', title: 'Triage', notes: 'Review GitHub issues.', cron: '0 9 * * *', timezone: 'UTC', untrusted: true}, me)
        expect(await own.runNow('greenhouse', s.id, me)).toMatchObject({outcome: 'sent', note: 'started a locked-down session for it (orrery-greenhouse-abc)'})
        expect(asked).toEqual([{project: 'greenhouse', schedule: s.id, text: 'Review GitHub issues.'}])
        room = false
        expect(await own.runNow('greenhouse', s.id, me)).toMatchObject({outcome: 'failed', note: 'untrusted, so it needs a session of its own: No launcher is running for greenhouse'})
        expect(signals.filter(x => x.kind === 'message')).toEqual([])
    })
})
