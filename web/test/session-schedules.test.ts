import {beforeEach, describe, expect, it} from 'vitest'
import type {OrreryEvent} from '#shared/happenings'
import type {Preset, Signal} from '#shared/roadmap'
import type {SessionStart} from '../server/utils/schedules'
import {Schedules, scheduleRunning} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

const me = {name: 'skoll', owner: true}
const agent = {name: 'claude', owner: false}
let store: Store
let schedules: Schedules
let signals: Signal[]
let heard: {event: OrreryEvent, cause?: number}[]
/** The sessions the schedules started, and whether there's room for another (else a 409, as the launcher says). */
let started: SessionStart[]
let room: boolean
let release: Preset
let review: Preset

beforeEach(async () => {
    signals = []
    heard = []
    started = []
    room = true
    store = new Store(testDb(), () => {}, signal => signals.push(signal))
    store.happened = event => heard.push({event, cause: scheduleRunning.getStore()})
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    await store.updateProject('greenhouse', {release_mode: 'own'})
    release = await store.createPreset(null, {name: 'Release', text: 'Cut the release.'}, me)
    review = await store.createPreset('greenhouse', {name: 'Review', text: 'Review its pull request.'}, me)
    schedules = new Schedules(store, () => {}, () => 1, undefined, undefined, async (_project, start) => {
        if (!room) throw Object.assign(new Error('Orrery already has its 2 sessions at once'), {statusCode: 409})
        started.push(start)
        return {tmux: 'orrery-greenhouse-abc'}
    })
})

async function failure(call: () => unknown): Promise<{status: number, message: string}> {
    try {
        await call()
    } catch (error) {
        const {statusCode, message} = error as {statusCode: number, message: string}
        return {status: statusCode, message}
    }
    throw new Error('it did not fail')
}

async function pass(now = new Date()): Promise<number> {
    let ran = 0
    for (const {event, cause} of heard.splice(0)) ran += await schedules.hear(event, cause, now)
    return ran
}

describe('a message schedule with presets', () => {
    it('sends their text, read at each run, before its own words, labelled by their names', async () => {
        const s = await schedules.create('greenhouse', {kind: 'message', title: 'Friday release', presets: [release.id], notes: 'For rc.9.', cron: '0 9 * * 5', timezone: 'UTC'}, me)
        expect(s.presets).toEqual([release.id])
        await schedules.runNow('greenhouse', s.id, me)
        await store.updatePreset(release.id, {text: 'Cut the release, then post notes.'}, me)
        await schedules.runNow('greenhouse', s.id, me)
        expect(signals.map(x => [x.note, x.preset])).toEqual([['Cut the release.\n\nFor rc.9.', 'Release'], ['Cut the release, then post notes.\n\nFor rc.9.', 'Release']])
    })

    it('needs words of its own or a preset, and only presets its project can have', async () => {
        expect(await schedules.create('greenhouse', {kind: 'message', title: 'Release', presets: [release.id], cron: '0 9 * * 5'}, me)).toMatchObject({notes: undefined})
        expect((await failure(() => schedules.create('greenhouse', {kind: 'message', title: 'Empty', cron: '0 9 * * 5'}, me))).status).toBe(400)
        await store.createProject({name: 'pantry', key: 'PAN'})
        expect(await failure(() => schedules.create('pantry', {kind: 'message', title: 'x', presets: [review.id], cron: '0 9 * * 5'}, me)))
            .toMatchObject({status: 400, message: expect.stringContaining(`No preset ${review.id} for pantry`)})
        expect((await failure(() => schedules.create('greenhouse', {kind: 'message', title: 'x', presets: 'Release', cron: '0 9 * * 5'}, me))).status).toBe(400)
    })

    it('fails a run saying why once a preset it names is gone', async () => {
        const s = await schedules.create('greenhouse', {kind: 'message', title: 'Review', presets: [review.id], cron: '0 9 * * 5'}, me)
        await store.deletePreset(review.id, me)
        expect(await schedules.runNow('greenhouse', s.id, me)).toMatchObject({outcome: 'failed', note: expect.stringContaining(`No preset ${review.id}`)})
        expect(signals).toEqual([])
    })
})

describe('a session schedule', () => {
    it('starts a session with its presets and words on a clock', async () => {
        const s = await schedules.create('greenhouse', {kind: 'session', title: 'Morning review', presets: [review.id, release.id], notes: 'Start with the oldest.', cron: '0 9 * * *'}, me)
        expect(await schedules.runNow('greenhouse', s.id, me)).toMatchObject({outcome: 'sent', note: 'started a session (orrery-greenhouse-abc)'})
        expect(started).toEqual([{presets: [review.id, release.id], instructions: 'Start with the oldest.'}])
        expect(signals).toEqual([])
    })

    it('starts on what the event was about: the issue, or the release', async () => {
        await schedules.create('greenhouse', {kind: 'session', title: 'Review', presets: [review.id], on: 'issue.status', on_filter: {to: 'in-review'}}, me)
        await schedules.create('greenhouse', {kind: 'session', title: 'Release', presets: [release.id], on: 'release.frozen'}, me)
        const issue = await store.createIssue('greenhouse', {title: 'Shelf labels'}, me)
        await store.updateIssue('greenhouse', issue.id, {status: 'in-review'}, agent)
        await pass()
        await store.createRelease('greenhouse', {version: '1.0.0'}, me)
        await store.updateRelease('greenhouse', '1.0.0', {frozen_on: '2026-10-27'}, me)
        await pass()
        expect(started).toEqual([
            {presets: [review.id], instructions: `On issue.status: ${issue.id} (backlog → in-review), by claude.`, issue: issue.id},
            {presets: [release.id], instructions: 'On release.frozen: 1.0.0, by the owner.', release: '1.0.0'},
        ])
    })

    it("is skipped saying why when there's no room for a session", async () => {
        const s = await schedules.create('greenhouse', {kind: 'session', title: 'Review', presets: [review.id], on: 'issue.status'}, me)
        room = false
        expect(await schedules.runNow('greenhouse', s.id, me)).toMatchObject({outcome: 'skipped', note: 'Orrery already has its 2 sessions at once'})
    })

    it("is the owner's to make, as it starts work as them", async () => {
        expect(await failure(() => schedules.create('greenhouse', {kind: 'session', title: 'x', cron: '0 9 * * *'}, agent))).toMatchObject({status: 403})
        const s = await schedules.create('greenhouse', {kind: 'issue', title: 'x', cron: '0 9 * * *'}, agent)
        expect(await failure(() => schedules.update('greenhouse', s.id, {kind: 'session'}, agent))).toMatchObject({status: 403})
        expect((await schedules.update('greenhouse', s.id, {kind: 'session', presets: [review.id]}, me)).presets).toEqual([review.id])
        // Back to an issue, it's given no presets.
        expect((await schedules.update('greenhouse', s.id, {kind: 'issue'}, me)).presets).toEqual([])
    })
})
