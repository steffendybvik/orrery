import {type ChildProcess, spawn} from 'node:child_process'
import {once} from 'node:events'
import {copyFileSync, existsSync, mkdirSync, rmSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {expect, test} from '@playwright/test'
import {e2ePort} from '../../e2e-port'
import {AGENT, OWNER} from '../support'

// Moving an orrery to a server (ORR-1209), as the hosting doc's steps say: each orrery here is the built app with its
// Rust API (the config's NUXT_API_BIN) on a folder of its own, one running at a time. A board's file brought into a
// fresh orrery, and the whole orrery as a copy of its database and secrets' key, with nothing else carried over: the
// file alone has everything once orrery has stopped (ORR-1214).
test.describe.configure({mode: 'serial'})

const WEB = fileURLToPath(new URL('../..', import.meta.url))
const port = e2ePort(3900)
const base = `http://localhost:${port}`
const ROOT = `${WEB}/.data/e2e-move`
// A one-pixel PNG, for a picture that has to travel with its comment.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let server: ChildProcess | undefined

/** Starts the orrery whose database is `folder`/orrery.db, its key beside it as an orrery keeps it. */
async function start(folder: string) {
    mkdirSync(`${ROOT}/${folder}`, {recursive: true})
    server = spawn('node', ['.output/server/index.mjs'], {
        cwd: WEB, stdio: 'inherit',
        env: {...process.env, NUXT_DATABASE: `${ROOT}/${folder}/orrery.db`, NUXT_UPDATE_CHECK: 'false', ORRERY_AUTH: 'off', PORT: String(port), NITRO_HOST: '127.0.0.1'},
    })
    // Ready once a route that's the API's alone answers, not only this server's own.
    await expect.poll(() => fetch(`${base}/api/projects`).then(r => r.ok, () => false), {timeout: 60_000}).toBe(true)
}

async function stop() {
    if (!server || server.exitCode !== null) return
    const exited = once(server, 'exit')
    server.kill('SIGTERM')
    await exited
}

const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {...init, headers: {'content-type': 'application/json', ...OWNER, ...init.headers}})
const json = async <T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await call(path, init)
    expect(res.ok, `${init.method ?? 'GET'} ${path}: ${res.status} ${await res.clone().text()}`).toBeTruthy()
    return await res.json() as T
}
const post = (path: string, body: object, headers: Record<string, string> = {}) => json(path, {method: 'POST', body: JSON.stringify(body), headers})

/** An orrery with something of everything a move has to carry: a named owner, a second person and a key, a board with
 * an issue, a comment holding a picture, a doc and a schedule, a preset, and a secret. */
async function fill() {
    await json('/api/owner', {method: 'PUT', body: JSON.stringify({name: 'Ada Lovelace'})})
    const {key} = await post('/api/keys', {kind: 'person', name: 'the phone'}) as {key: string}
    await post('/api/projects', {name: 'Observatory', key: 'OBS'}, AGENT)
    const issue = await post('/api/projects/observatory/issues', {title: 'Polish the lens'}, AGENT) as {id: string}
    const picture = await post('/api/uploads', {name: 'lens.png', data: PNG}, AGENT) as {url: string}
    await post(`/api/projects/observatory/issues/${issue.id}/comments`, {body: `The lens, before:\n\n![The lens](${picture.url})`}, AGENT)
    await post('/api/projects/observatory/docs', {title: 'Star charts', body: 'Kept in the east drawer.'}, AGENT)
    await post('/api/projects/observatory/schedules', {title: 'Wind the clock', cron: '0 9 * * *', timezone: 'UTC'}, AGENT)
    await post('/api/presets', {name: 'Night shift', text: 'Work while the dome is shut.'})
    await json('/api/secrets/STAR_KEY', {method: 'PUT', body: JSON.stringify({value: 'star-value-wxyz', hosts: ['api.example.com', 'cdn.example.com']})})
    // Last: with a second person, a session's writes have to say whose they are.
    await post('/api/people', {name: 'Skoll Varg'})
    return {issue: issue.id, picture: picture.url, key}
}

/** The board's issue, its comment and picture, and its doc are all there. */
async function boardIsThere(issue: string, picture: string) {
    expect((await json(`/api/projects/observatory/issues/${issue}`)).title).toBe('Polish the lens')
    const comments = await json<{body: string}[]>(`/api/projects/observatory/issues/${issue}/comments`)
    expect(comments.map(c => c.body)).toContainEqual(expect.stringContaining(`![The lens](${picture})`))
    const image = await call(picture)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toContain('image/png')
    const docs = await json<{id: string, title: string}[]>('/api/projects/observatory/docs')
    const doc = docs.find(d => d.title === 'Star charts')
    expect(doc).toBeTruthy()
    expect((await json(`/api/projects/observatory/docs/${doc!.id}`)).body).toBe('Kept in the east drawer.')
}

let made: Awaited<ReturnType<typeof fill>>

test.beforeAll(async () => {
    rmSync(ROOT, {recursive: true, force: true})
    await start('mac')
    made = await fill()
    await stop()
})

test.afterAll(stop)

test('brings the whole orrery along as a copy of its database and key: people, keys, boards, presets, schedules and secrets', async ({page}) => {
    // The hosting doc's steps: the database and the key, and nothing else, into the new server's folder before it starts.
    mkdirSync(`${ROOT}/box`, {recursive: true})
    copyFileSync(`${ROOT}/mac/orrery.db`, `${ROOT}/box/orrery.db`)
    copyFileSync(`${ROOT}/mac/orrery.key`, `${ROOT}/box/orrery.key`)
    await start('box')

    expect(await json('/api/owner')).toMatchObject({name: 'ada_lovelace', display: 'Ada Lovelace', named: true})
    expect((await json<{name: string}[]>('/api/people')).map(p => p.name)).toEqual(expect.arrayContaining(['Ada Lovelace', 'Skoll Varg']))
    // The old person key signs in, so there's nothing to claim.
    const login = await call('/api/auth/login', {method: 'POST', body: JSON.stringify({key: made.key})})
    expect(login.status, await login.clone().text()).toBe(200)
    await boardIsThere(made.issue, made.picture)
    expect((await json<{title: string}[]>('/api/projects/observatory/schedules')).map(s => s.title)).toContain('Wind the clock')
    expect((await json<{name: string}[]>('/api/presets')).map(p => p.name)).toContain('Night shift')
    // The secret opens with the same key: narrowing its hosts opens and seals it again.
    const narrowed = await call('/api/secrets/STAR_KEY', {method: 'PATCH', body: JSON.stringify({hosts: ['api.example.com']})})
    expect(narrowed.status, await narrowed.clone().text()).toBe(200)
    expect((await narrowed.json()).hosts).toEqual(['api.example.com'])

    await page.goto(`${base}/p/observatory/issues/${made.issue}`)
    await expect(page.getByRole('heading', {name: 'Polish the lens'})).toBeVisible()
    // The page's streams would hold the server's shutdown open for its whole timeout.
    await page.close()
    await stop()
})

test('copied without its key, the secrets won\'t open and say to set them again', async () => {
    mkdirSync(`${ROOT}/keyless`, {recursive: true})
    copyFileSync(`${ROOT}/mac/orrery.db`, `${ROOT}/keyless/orrery.db`)
    await start('keyless')
    // A key of its own is made for it, which isn't the one the secret was sealed with.
    expect(existsSync(`${ROOT}/keyless/orrery.key`)).toBe(true)
    expect((await json<{name: string}[]>('/api/secrets')).map(s => s.name)).toContain('STAR_KEY')
    const narrowed = await call('/api/secrets/STAR_KEY', {method: 'PATCH', body: JSON.stringify({hosts: ['api.example.com']})})
    expect(narrowed.status).toBe(503)
    expect(await narrowed.text()).toContain('won\'t open')
    // The rest of the orrery is all there; only the secrets need setting again.
    await boardIsThere(made.issue, made.picture)
    await stop()
})

test('brings a board into a fresh orrery from its file, with its comments, pictures and docs', async ({page}) => {
    await start('mac')
    const file = await (await call('/api/projects/observatory/export')).text()
    await stop()

    await start('fresh')
    await json('/api/owner', {method: 'PUT', body: JSON.stringify({name: 'Ada Lovelace'})})
    const uploaded = await call('/api/projects/upload', {method: 'POST', body: file})
    expect(uploaded.status, await uploaded.clone().text()).toBe(201)
    await boardIsThere(made.issue, made.picture)
    // Its schedules come paused, and nothing on it is the new orrery's owner's.
    const [schedule] = await json<{title: string, enabled: boolean}[]>('/api/projects/observatory/schedules')
    expect(schedule).toMatchObject({title: 'Wind the clock', enabled: false})

    await page.goto(`${base}/p/observatory/issues/${made.issue}`)
    await expect(page.getByRole('heading', {name: 'Polish the lens'})).toBeVisible()
    await expect(page.getByText('brought it in from a file')).toBeVisible()
    await expect(page.getByRole('img', {name: 'The lens'})).toBeVisible()
    await page.close()
    await stop()
})
