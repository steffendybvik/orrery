import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Signal} from '#shared/roadmap'
import {Schedules} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// A working session asking the owner for a schedule on its issue (ORR-458), with Nitro's auto-imports stubbed: the
// comment waiting on their decision, the request beside it, and Allow saving the schedule as theirs.
const agent = {name: 'claude', owner: false, session: 'orrery · Skade'}
let store: Store
let schedules: Schedules
let signals: Signal[]
let notes: {kind: string}[]
let requests: typeof import('../server/utils/schedule-requests')
let owner: {name: string, owner: true}
let issue: string

const error = (statusCode: number) => (message: string) => Object.assign(new Error(message), {statusCode})

beforeEach(async () => {
    signals = []
    notes = []
    store = new Store(testDb(), () => {}, signal => signals.push(signal))
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    issue = (await store.createIssue('greenhouse', {title: 'Water the plants'}, agent)).id
    schedules = new Schedules(store)
    owner = {name: (await store.ownerOf()).name, owner: true}
    vi.stubGlobal('useStore', () => store)
    vi.stubGlobal('useScheduler', () => schedules)
    vi.stubGlobal('useEventLog', () => ({note: (entry: {kind: string}) => notes.push(entry)}))
    for (const [name, status] of [['badRequest', 400], ['forbidden', 403], ['notFound', 404], ['conflict', 409]] as const) vi.stubGlobal(name, error(status))
    vi.stubGlobal('createError', (input: {statusCode: number, message: string}) => Object.assign(new Error(input.message), input))
    vi.resetModules()
    requests = await import('../server/utils/schedule-requests')
})

afterEach(() => vi.unstubAllGlobals())

async function status(call: () => unknown): Promise<number> {
    try {
        await call()
        return 200
    } catch (error) {
        return (error as {statusCode: number}).statusCode
    }
}

describe("a working session's request for a schedule", () => {
    it("asks on its issue, saves nothing, and on Allow makes the schedule the owner's, answering in their comment", async () => {
        const asked = await requests.askScheduleOn('greenhouse', issue, {schedule: {title: 'Morning check', kind: 'message', notes: 'Look at the board.', cron: '0 9 * * 1-5'}, why: 'You asked for a daily nudge.'}, agent)
        expect(asked).toMatchObject({asks: 'decision', answered: false, created_by: 'claude', schedule: {title: 'Morning check', state: 'asked'}})
        expect(asked.body).toMatch(/^You asked for a daily nudge\.\n\nAsks to make the schedule "Morning check"/)
        expect(await schedules.list('greenhouse')).toEqual([])
        expect((await store.issue('greenhouse', issue)).assignee).toBe(owner.name)

        // Not the session's to allow.
        expect(await status(() => requests.answerScheduleRequest('greenhouse', issue, asked.id, true, agent))).toBe(403)
        expect(await schedules.list('greenhouse')).toEqual([])

        const answered = await requests.answerScheduleRequest('greenhouse', issue, asked.id, true, owner)
        const [made] = await schedules.list('greenhouse')
        expect(made).toMatchObject({title: 'Morning check', kind: 'message', created_by: owner.name, protected: true})
        expect(answered).toMatchObject({answered: true, schedule: {id: made!.id, state: 'allowed'}})
        const comments = await store.listComments('greenhouse', issue)
        expect(comments.at(-1)).toMatchObject({created_by: owner.name, body: `Allowed: schedule ${made!.id} ("Morning check") is saved as mine.`})
        // The owner's answer reaches the session, as their comments do.
        expect(signals.some(s => s.kind === 'comment' && s.note?.startsWith('Allowed'))).toBe(true)
        expect(await status(() => requests.answerScheduleRequest('greenhouse', issue, asked.id, false, owner))).toBe(409)
        expect(notes.map(n => n.kind)).toEqual(['schedule.asked', 'schedule.answered'])
    })

    it('asks for a session schedule, which it could never make itself', async () => {
        const asked = await requests.askScheduleOn('greenhouse', issue, {schedule: {title: 'Nightly review', kind: 'session', notes: 'Review the day.', cron: '0 2 * * *'}}, agent)
        await requests.answerScheduleRequest('greenhouse', issue, asked.id, true, owner)
        expect(await schedules.list('greenhouse')).toMatchObject([{title: 'Nightly review', kind: 'session', created_by: owner.name}])
    })

    it('changes one field by field, and Deny saves nothing', async () => {
        const nightly = await schedules.create('greenhouse', {title: 'Nightly', kind: 'message', notes: 'Hi', cron: '0 2 * * *'}, owner)
        const asked = await requests.askScheduleOn('greenhouse', issue, {id: nightly.id, schedule: {enabled: false}}, agent)
        expect(asked.schedule).toMatchObject({id: nightly.id, changes: [{field: 'enabled', from: true, to: false}]})
        await requests.answerScheduleRequest('greenhouse', issue, asked.id, false, owner)
        expect((await schedules.get('greenhouse', nightly.id)).enabled).toBe(true)
        expect((await store.comment('greenhouse', issue, asked.id)).schedule!.state).toBe('denied')
        expect((await store.listComments('greenhouse', issue)).at(-1)!.body).toMatch(/^Denied: don't change schedule/)
    })

    it('expires the earlier request when it asks again for the same schedule', async () => {
        const first = await requests.askScheduleOn('greenhouse', issue, {schedule: {title: 'Weekly', kind: 'message', notes: 'A', cron: '0 9 * * 1'}}, agent)
        const second = await requests.askScheduleOn('greenhouse', issue, {schedule: {title: 'Weekly', kind: 'message', notes: 'B', cron: '0 9 * * 1'}}, agent)
        expect((await store.comment('greenhouse', issue, first.id)).schedule!.state).toBe('expired')
        expect(await status(() => requests.answerScheduleRequest('greenhouse', issue, first.id, true, owner))).toBe(409)
        expect(second.schedule!.state).toBe('asked')
    })

    it('is checked as Schedules would check it, and the owner asks no one', async () => {
        expect(await status(() => requests.askScheduleOn('greenhouse', issue, {schedule: {title: 'Bad', cron: 'often'}}, agent))).toBe(400)
        expect(await status(() => requests.askScheduleOn('greenhouse', issue, {schedule: {title: 'X', cron: '0 9 * * *', untrusted: true}}, agent))).toBe(403)
        expect(await status(() => requests.askScheduleOn('greenhouse', issue, {schedule: {title: 'X', cron: '0 9 * * *'}}, owner))).toBe(400)
        expect(await store.listComments('greenhouse', issue)).toEqual([])
    })
})
