import {expect, test} from '@playwright/test'
import {AGENT, OWNER, makeProject, projectApi} from './support'

// The routes no other spec calls by name (ORR-746), through the real server, for what each does and who may call it.
test.describe.configure({mode: 'serial'})

const api = projectApi('stoneyard')
const roadmap = (title: string) => ({chunks: [{id: 'c1', title: 'Stone', tasks: [{id: 'STY-1', title, status: 'todo'}]}]})

test.beforeAll(async ({request}) => {
    await makeProject(request, {name: 'Stoneyard', key: 'STY'})
})

test('imports a roadmap into an empty project, and replaces one only when asked and allowed', async ({request}) => {
    const post = (path: string, data: object, headers = OWNER) => request.post(`/api/projects/stoneyard/import${path}`, {data, headers})
    expect((await post('', {chunks: 'none'})).status()).toBe(400)
    expect((await post('', roadmap('Cut the first block'))).ok()).toBeTruthy()
    expect((await post('', roadmap('Cut another'))).status()).toBe(409)
    expect((await post('?replace=true', roadmap('Cut another'), AGENT)).status()).toBe(403)
    expect((await post('?replace=true', roadmap('Cut another'))).ok()).toBeTruthy()
    const issues: {title: string}[] = await api(request, 'get', '/issues')
    expect(issues.map(issue => issue.title)).toEqual(['Cut another'])
})

test('lists an issue\'s activity, the project\'s deleted docs and how many listen', async ({request}) => {
    const issue = await api(request, 'post', '/issues', {title: 'Haul it out'})
    expect((await api(request, 'get', `/issues/${issue.id}/activity`)).map((event: {field: string}) => event.field)).toContain('created')
    expect((await request.get(`/api/projects/stoneyard/issues/STY-999/activity`)).status()).toBe(404)
    const doc = await api(request, 'post', '/docs', {title: 'Blasting plan', body: 'Stand well back'})
    expect((await request.delete(`/api/projects/stoneyard/docs/${doc.id}`, {headers: AGENT})).ok()).toBeTruthy()
    expect(await api(request, 'get', '/deleted-docs')).toMatchObject([{id: doc.id, title: 'Blasting plan', deleted_by: 'claude'}])
    expect(await api(request, 'get', '/listeners')).toEqual({count: 0})
})

test('makes an agent\'s schedule the owner\'s only for the owner, and only as they read it', async ({request}) => {
    const schedule = await api(request, 'post', '/schedules', {title: 'Check the drills', cron: '0 9 * * 1', timezone: 'UTC'})
    const adopt = (data: object, headers = OWNER) => request.post(`/api/projects/stoneyard/schedules/${schedule.id}/adopt`, {data, headers})
    expect((await adopt({}, AGENT)).status()).toBe(403)
    expect((await adopt({seen: 1})).status()).toBe(400)
    expect((await adopt({seen: '2000-01-01T00:00:00.000Z'})).status()).toBe(409)
    expect((await adopt({seen: schedule.updated_at})).ok()).toBeTruthy()
})

test('keeps schedules across projects to the owner, and lists, changes and deletes them', async ({request}) => {
    const body = {projects: ['stoneyard'], title: 'Weekly survey', cron: '0 9 * * 1', timezone: 'UTC'}
    expect((await request.post('/api/schedules', {data: body, headers: AGENT})).status()).toBe(403)
    const made = await request.post('/api/schedules', {data: body, headers: OWNER})
    expect(made.status()).toBe(201)
    const {id} = await made.json()
    const listed = await (await request.get('/api/schedules/across')).json()
    expect(listed.find((across: {id: number}) => across.id === id)).toMatchObject({title: 'Weekly survey', on_projects: ['stoneyard']})
    expect((await request.patch(`/api/schedules/across/${id}`, {data: {title: 'Monthly survey'}, headers: AGENT})).status()).toBe(403)
    expect((await request.patch(`/api/schedules/across/${id}`, {data: {title: 'Monthly survey'}, headers: OWNER})).ok()).toBeTruthy()
    expect((await request.delete(`/api/schedules/across/${id}`, {headers: AGENT})).status()).toBe(403)
    expect((await request.delete(`/api/schedules/across/${id}`, {headers: OWNER})).status()).toBe(204)
})

test('keeps restoring and resetting presets to the owner', async ({request}) => {
    expect((await request.post('/api/presets/defaults', {headers: AGENT})).status()).toBe(403)
    expect((await request.post('/api/presets/defaults', {headers: OWNER})).ok()).toBeTruthy()
    const presets: {id: number, default?: unknown}[] = await (await request.get('/api/presets')).json()
    const one = presets.find(preset => preset.default)
    expect(one).toBeTruthy()
    expect((await request.post(`/api/presets/${one!.id}/reset`, {headers: AGENT})).status()).toBe(403)
    expect((await request.post(`/api/presets/${one!.id}/reset`, {headers: OWNER})).ok()).toBeTruthy()
})

test('forgets only a session it knows with no channel open, for the owner alone', async ({request}) => {
    const forget = (id: string, headers = OWNER) => request.post(`/api/projects/stoneyard/sessions/${id}/forget`, {headers})
    expect((await forget('nobody', AGENT)).status()).toBe(403)
    expect((await forget('nobody')).status()).toBe(404)
    expect((await request.post('/api/sessions', {data: {id: 'gone-stoneyard', project: 'stoneyard', event: 'SessionStart'}, headers: AGENT})).ok()).toBeTruthy()
    expect((await forget('gone-stoneyard')).ok()).toBeTruthy()
    expect((await forget('gone-stoneyard')).status()).toBe(404)
})

test('keeps checking a database to the owner, and refuses a kind it doesn\'t know', async ({request}) => {
    const check = (data: object, headers = OWNER) => request.post('/api/database/check', {data, headers})
    expect((await check({kind: 'sqlite', path: '/tmp/orrery-e2e-no-such.db'}, AGENT)).status()).toBe(403)
    // On Postgres the database is set by ORRERY_DATABASE, so there's nothing to check it against.
    expect((await check({kind: 'nonsense'})).status()).toBe(process.env.E2E_POSTGRES_URL ? 409 : 400)
})
