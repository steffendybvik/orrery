import {type ChildProcess, spawn} from 'node:child_process'
import {once} from 'node:events'
import {rmSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {expect, test} from '@playwright/test'
import {e2ePort} from '../../e2e-port'
import {AGENT, OWNER, hold} from '../support'

// The owner's chats outlive orrery restarting (ORR-877): a running chat and an ended one, with what was said in them,
// are listed again once the server is back, the running one still running while its launcher says it runs.
test.describe.configure({mode: 'serial'})

const WEB = fileURLToPath(new URL('../..', import.meta.url))
const port = e2ePort(3800)
const base = `http://localhost:${port}`
const DATABASE = '.data/e2e-restart.db'

let server: ChildProcess | undefined

async function start() {
    server = spawn('node', ['.output/server/index.mjs'], {
        cwd: WEB, stdio: 'inherit',
        env: {...process.env, NUXT_DATABASE: DATABASE, NUXT_BACKUP_DIR: '', NUXT_UPDATE_CHECK: 'false', ORRERY_AUTH: 'off', PORT: String(port), NITRO_HOST: '127.0.0.1'},
    })
    await expect.poll(() => fetch(`${base}/api/settings`).then(r => r.ok, () => false), {timeout: 60_000}).toBe(true)
}

async function stop() {
    if (!server || server.exitCode !== null) return
    const exited = once(server, 'exit')
    server.kill('SIGTERM')
    await exited
}

const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {...init, headers: {'content-type': 'application/json', ...OWNER, ...init.headers}})
type Listed = {id: string, project: string, ended?: boolean, messages: {text: string}[]}
const listed = async () => (await (await api('/api/chats')).json()) as Listed[]

test.beforeAll(() => {
    for (const end of ['', '-wal', '-shm', '.backups.json']) rmSync(`${WEB}/${DATABASE}${end}`, {force: true})
})

test.afterAll(stop)

test('lists a running chat and an ended one again after orrery restarts, with what was said in them', async ({page}) => {
    await start()
    expect((await api('/api/owner', {method: 'PUT', body: JSON.stringify({name: 'Ada Lovelace'})})).ok).toBeTruthy()
    const made = await api('/api/projects', {method: 'POST', headers: AGENT, body: JSON.stringify({name: 'Observatory', key: 'OBS'})})
    expect(made.ok, await made.text()).toBeTruthy()
    let launcher = hold(base, '/api/projects/observatory/launches/stream')
    const open = async (text: string) => {
        const chat = await (await api('/api/chats', {method: 'POST', body: JSON.stringify({project: 'observatory'})})).json() as {id: string}
        const said = await api(`/api/chats/${chat.id}/messages`, {method: 'POST', body: JSON.stringify({text})})
        expect(said.ok, await said.text()).toBeTruthy()
        return chat.id
    }
    try {
        await expect.poll(async () => (await (await api('/api/projects/observatory/launches')).json()).launchers).toBe(1)
        const ended = await open('Where are the star charts?')
        expect((await api(`/api/chats/${ended}/end`, {method: 'POST'})).ok).toBeTruthy()
        const running = await open('Who dusts the telescope?')
        await expect.poll(async () => (await listed()).map(c => [c.id, !!c.ended])).toEqual([[running, false], [ended, true]])

        launcher.stop()
        await stop()
        await start()
        // Its launcher connects again, saying the chat's session still runs.
        launcher = hold(base, '/api/projects/observatory/launches/stream')
        await expect.poll(async () => (await (await api('/api/projects/observatory/launches')).json()).launchers).toBe(1)
        const report = await api('/api/projects/observatory/launches/running', {method: 'POST', body: JSON.stringify({launches: [{id: running, tmux: `orrery-observatory-${running}`, chat: true}]})})
        expect(report.ok, await report.text()).toBeTruthy()

        expect((await listed()).map(c => [c.id, !!c.ended, c.messages.map(m => m.text)]))
            .toEqual([[running, false, ['Who dusts the telescope?']], [ended, true, ['Where are the star charts?']]])
        await page.goto(`${base}/p/observatory`)
        await page.getByRole('button', {name: /^Agent/}).click()
        const list = page.getByRole('region', {name: 'Chat'}).getByTestId('chat-list')
        await expect(list.getByRole('listitem').nth(0)).toContainText('Observatory(running)Who dusts the telescope?')
        await expect(list.getByRole('listitem').nth(1)).toContainText('Observatory(ended)Where are the star charts?')
    } finally {
        launcher.stop()
    }
})
