import {createServer} from 'node:http'
import type {Server} from 'node:http'
import type {AddressInfo} from 'node:net'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {apiForgotten, apiStarted} from '../server/utils/api-router'
import {Schedules} from '../server/utils/schedules'
import {Store} from '../server/utils/store'
import {testDb} from './db'

// A schedule's runs with the Rust API in front (ORR-1176): the clock stays here, reading the schedules from its database,
// but what a run writes (taking the run, its issue, its record, an event held back) goes to the API, and none of it here.

type Heard = {method: string, url: string, headers: Record<string, string | string[] | undefined>, body: unknown}

let server: Server
let url = ''
const heard: Heard[] = []
const urgent: string[] = []
/** What the fake API answers, by `<method> <path>`; anything else is 200 {}. */
let answers: Record<string, {status: number, body?: unknown, headers?: Record<string, string>}> = {}

const me = {name: 'skoll', owner: true}
let store: Store
let schedules: Schedules

beforeAll(async () => {
    vi.stubGlobal('useEventLog', () => ({note: () => {}}))
    vi.stubGlobal('databaseSetting', () => 'sqlite:test')
    vi.stubGlobal('useStore', () => ({
        relaying: async (run: () => Promise<void>) => await run(),
        changed: () => {},
        settingsChanged: async () => {},
        epicsChanged: () => {},
        told: () => {},
        handOn: async () => {},
        sayUrgent: async (_project: string, issue: string) => void urgent.push(issue),
    }))
    server = createServer((req, res) => {
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            heard.push({method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: body ? JSON.parse(body) : undefined})
            const answer = answers[`${req.method} ${req.url}`] ?? {status: 200, body: {}}
            res.writeHead(answer.status, {'Content-Type': 'application/json', ...answer.headers})
            res.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(async () => {
    heard.length = 0
    urgent.length = 0
    answers = {}
    store = new Store(testDb(), () => {}, () => {})
    await store.createProject({name: 'greenhouse', key: 'GRE'})
    schedules = new Schedules(store)
})

afterEach(() => {
    apiStarted(null)
    apiForgotten()
})

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllGlobals()
})

/** The writes the API heard, as `<method> <path>`. */
const writes = () => heard.filter(h => h.method !== 'GET').map(h => `${h.method} ${h.url}`)

describe('a schedule run with the API in front', () => {
    it('takes its run, makes its issue and records the run there, writing none of it here', async () => {
        const s = await schedules.create('greenhouse', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC', priority: 'P0'}, me)
        // The API and this server share the database, so the issue the API makes is there for the push to read.
        const issue = await store.createIssue('greenhouse', {title: 'Groom', priority: 'P0'}, me, {urgent: false})
        apiStarted({url, token: 't'})
        const base = `/api/projects/greenhouse/schedules/${s.id}`
        answers[`POST ${base}/claim`] = {status: 200, body: {claimed: true}}
        answers['POST /api/projects/greenhouse/issues'] = {status: 201, body: issue, headers: {'Orrery-Urgent': `greenhouse ${issue.id}`}}
        answers[`POST ${base}/runs`] = {status: 201, body: {}}
        const due = new Date(new Date(s.next_run!).getTime() + 60_000)
        expect(await schedules.runDue(due)).toBe(1)

        expect(writes()).toEqual([`POST ${base}/claim`, 'POST /api/projects/greenhouse/issues', `POST ${base}/runs`])
        const [claim, made, run] = heard.filter(h => h.method === 'POST')
        expect(claim!.body).toEqual({from: s.next_run, to: expect.any(String), enabled: true})
        expect(claim!.headers['orrery-actor-name']).toBe('orrery')
        expect(made!.body).toMatchObject({title: expect.stringMatching(/^Groom · /), priority: 'P0', status: 'todo'})
        // The issue is the schedule maker's, as the run's.
        expect(made!.headers['orrery-actor-name']).toBe('skoll')
        expect(run!.body).toMatchObject({outcome: 'made', issue: issue.id, at: due.toISOString()})
        // The API's word that it's urgent isn't pushed again: the run asks the sessions itself, here.
        expect(urgent).toEqual([])

        apiStarted(null)
        apiForgotten()
        expect(await store.db.get('SELECT 1 FROM schedule_runs')).toBeUndefined()
        expect((await store.db.get<{next_run: string}>('SELECT next_run FROM schedules WHERE id = ?', s.id))!.next_run).toBe(s.next_run)
    })

    it('runs nothing when another server took the run first', async () => {
        const s = await schedules.create('greenhouse', {title: 'Groom', cron: '0 9 * * *', timezone: 'UTC'}, me)
        apiStarted({url, token: 't'})
        answers[`POST /api/projects/greenhouse/schedules/${s.id}/claim`] = {status: 200, body: {claimed: false}}
        expect(await schedules.runDue(new Date(new Date(s.next_run!).getTime() + 60_000))).toBe(0)
        expect(writes()).toEqual([`POST /api/projects/greenhouse/schedules/${s.id}/claim`])
    })

    it('holds an event back in the API within the minute, and takes it out there once the minute is up', async () => {
        const s = await schedules.create('greenhouse', {title: 'Triage', on: 'issue.created'}, me)
        const issue = await store.createIssue('greenhouse', {title: 'Seed'}, me)
        // Its last run was just now, so the next event waits for the minute.
        await store.db.run("INSERT INTO schedule_runs (schedule, at, outcome) VALUES (?, ?, 'made')", s.id, new Date().toISOString())
        apiStarted({url, token: 't'})
        answers[`GET /api/projects/greenhouse/issues/${issue.id}`] = {status: 200, body: issue}
        await schedules.hear({type: 'issue.created', project: 'greenhouse', subject: issue.id, by: {name: 'claude', owner: false}})
        expect(writes()).toEqual([`PUT /api/schedules/${s.id}/held/${issue.id}`])
        expect(heard.at(-1)!.body).toMatchObject({event: expect.stringContaining('"issue.created"'), at: expect.any(String)})
    })
})
