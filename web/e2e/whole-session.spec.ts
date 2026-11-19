import type {ChildProcess} from 'node:child_process'
import {execFile, execFileSync, spawn} from 'node:child_process'
import {chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {expect, test} from './test'
import {FAKE_TMUX} from '../test/fake-tmux'
import {OWNER, makeProject, projectApi} from './support'

// A session's whole path on a real orrery (ORR-732): the real launcher, channel and hook together, where each other test has a
// stand-in for one side. Only Claude and tmux are fakes. A real Claude can't run here, as it needs a login and costs money, so
// this test does what it would do: it reads the launcher's start out of the fake tmux, runs the channel with what the launcher
// handed down, plays the hooks Claude Code would, and calls the channel's tools.
const CHANNEL = fileURLToPath(new URL('../../channel/orrery-channel.mjs', import.meta.url))
const HOOK = fileURLToPath(new URL('../../channel/orrery-hook.mjs', import.meta.url))
const LAUNCHER = fileURLToPath(new URL('../../channel/orrery-launcher.mjs', import.meta.url))
const WAIT = {timeout: 20_000}

type Heard = {content: string, meta?: Record<string, string>}
type Listed = {id: string, listening: boolean, started?: {launch: string}, state: string}

/** A machine: a fake tmux first on PATH, a repo and a home of its own, and the launcher to start on them. */
function machine(baseURL: string, project: string) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orrery-whole-session-')))
    const [bin, fake, home, sockets, repo] = ['bin', 'fake', 'home', 'sockets', 'repo'].map(part => join(root, part)) as [string, string, string, string, string]
    for (const dir of [bin, fake, home, sockets, repo]) mkdirSync(dir)
    writeFileSync(join(bin, 'tmux'), FAKE_TMUX)
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}\n`)
    for (const name of ['tmux', 'claude']) chmodSync(join(bin, name), 0o755)
    writeFileSync(join(fake, 'calls'), '')
    writeFileSync(join(fake, 'state.json'), '{}')
    const env = {PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMUX_TMPDIR: sockets, FAKE_TMUX: fake, ...process.env.NODE_V8_COVERAGE ? {NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE} : {}}
    const calls = (): string[][] => readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    return {
        env, home, calls,
        /** How many times a launcher has said its stream to orrery is open. */
        ready: () => readFileSync(join(root, 'launcher.log'), 'utf8').split('\n').filter(line => line.includes('ready to start')).length,
        startLauncher() {
            expect(execFileSync('tmux', ['-V'], {env, encoding: 'utf8'}).trim()).toBe('tmux 3.4-fake')
            return spawn(process.execPath, [LAUNCHER], {cwd: repo, stdio: ['ignore', openSync(join(root, 'launcher.log'), 'a'), openSync(join(root, 'launcher.log'), 'a')], env: {...env, ORRERY_PROJECT: project, ORRERY_URL: baseURL}})
        },
    }
}

/** What Claude Code does for a session the launcher started: its channel, and its hooks. */
async function claude(env: Record<string, string>, handedDown: Record<string, string>, id: string) {
    const window = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'})
    const heard: Heard[] = []
    const client = new Client({name: 'claude', version: '1'}, {capabilities: {experimental: {'claude/channel': {}}}})
    client.fallbackNotificationHandler = async ({method, params}) => {
        if (method === 'notifications/claude/channel') heard.push(params as Heard)
    }
    const session = {...env, ...handedDown, CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: String(window.pid)}
    const transport = new StdioClientTransport({command: process.execPath, args: [CHANNEL], cwd: env.HOME, stderr: 'ignore', env: session})
    await client.connect(transport)
    return {
        heard, client,
        /** Its hook on this event, as Claude Code runs it; says what it printed, which Claude Code adds to the context. */
        hook: (event: string, sessionId: string, fields: Record<string, unknown> = {}) => new Promise<string>((resolve, reject) => {
            const run = execFile(process.execPath, [HOOK], {env: session}, (error, out) => error ? reject(error) : resolve(out))
            run.stdin?.end(JSON.stringify({session_id: sessionId, hook_event_name: event, cwd: env.HOME, ...fields}))
        }),
        async stop() {
            window.kill()
            if (transport.pid) process.kill(transport.pid)
            await client.close()
        },
    }
}

const texts = (heard: Heard[]) => heard.map(h => h.content).join('\n')

test('a session goes from its start to its stop through the real launcher, channel and hook', async ({request, baseURL}) => {
    test.setTimeout(120_000)
    const {id: project} = await makeProject(request, {name: 'Wholepath', key: 'WHP'})
    const api = projectApi(project)
    const sessions = async () => await api(request, 'get', '/sessions') as Listed[]
    const issue = async (id: string) => api(request, 'get', `/issues/${id}`) as Promise<{status: string, assignee?: string}>
    // The limit counts every project's launches on their way, and the specs before this one leave some that no launcher takes,
    // held up to 30 minutes when an outdated launcher refused them: at 3 it had no room, so its focus started nothing (ORR-912).
    await request.patch('/api/settings', {data: {starts: {limit: 20}}, headers: OWNER})
    const box = machine(baseURL!, project)
    const running: ChildProcess[] = []
    let window: Awaited<ReturnType<typeof claude>> | undefined
    try {
        running.push(box.startLauncher())

        await test.step('a focus that asks for a session has the launcher start one in tmux', async () => {
            const {id} = await api(request, 'post', '/issues', {title: 'Water the beds', status: 'todo'}, OWNER)
            expect(id).toBe('WHP-1')
            // Only once the launcher is connected can a session start.
            await expect.poll(async () => (await api(request, 'get', '/launches')).launchers, WAIT).toBeGreaterThan(0)
            await api(request, 'post', '/issues/WHP-1/focus', {start: true}, OWNER)
            await expect.poll(() => box.calls().filter(call => call[0] === 'new-session').length, WAIT).toBe(1)
        })

        const started = box.calls().find(call => call[0] === 'new-session')!
        expect(started).toContain('claude')
        const handedDown = Object.fromEntries(started.flatMap((word, at) => started[at - 1] === '-e' ? [word.split(/=(.*)/s).slice(0, 2) as [string, string]] : []))
        expect(handedDown.ORRERY_STARTED).toBeTruthy()

        await test.step('its channel and hook make it a started session, and it hears the focus', async () => {
            window = await claude(box.env, handedDown, 'window-1')
            await window.hook('SessionStart', 'window-1', {source: 'startup'})
            await expect.poll(async () => (await sessions()).find(s => s.id === 'window-1'), WAIT).toMatchObject({listening: true, started: {launch: handedDown.ORRERY_STARTED}})
            await expect.poll(() => texts(window!.heard), WAIT).toContain('WHP-1')
        })

        await test.step('it starts the issue through the channel, and the owner\'s comment reaches it', async () => {
            await window!.hook('UserPromptSubmit', 'window-1')
            await window!.client.callTool({name: 'start_issue', arguments: {id: 'WHP-1', comment: 'On it.'}})
            expect(await issue('WHP-1')).toMatchObject({status: 'in-progress', assignee: 'claude'})
            await api(request, 'post', '/issues/WHP-1/comments', {body: 'Use the green can'}, OWNER)
            await expect.poll(() => texts(window!.heard), WAIT).toContain('Use the green can')
        })

        await test.step('idle with the issue done, the launcher clears it, and it stays the same session', async () => {
            await window!.client.callTool({name: 'finish_issue', arguments: {id: 'WHP-1', comment: 'Watered.', status: 'done'}})
            await window!.hook('Stop', 'window-1')
            await expect.poll(() => box.calls().some(call => call[0] === 'send-keys' && call.includes('/clear')), WAIT).toBe(true)
            await window!.hook('SessionEnd', 'window-1', {reason: 'clear'})
            await window!.hook('SessionStart', 'window-2', {source: 'clear'})
            const after = await sessions()
            expect(after.map(s => s.id)).toEqual(['window-2'])
            expect(after[0]).toMatchObject({listening: true, started: {launch: handedDown.ORRERY_STARTED}})
        })

        await test.step('idle after its clear, it is handed the next issue to land in Todo', async () => {
            await window!.hook('Stop', 'window-2')
            await api(request, 'post', '/issues', {title: 'Label the jars', status: 'todo'}, OWNER)
            await expect.poll(() => texts(window!.heard), WAIT).toContain('WHP-2')
            await window!.hook('UserPromptSubmit', 'window-2')
            await window!.client.callTool({name: 'start_issue', arguments: {id: 'WHP-2', comment: 'On it.'}})
        })

        await test.step('a launcher restarting takes the session back, without starting another', async () => {
            running.shift()!.kill('SIGKILL')
            running.push(box.startLauncher())
            // Until its stream is open, there's nothing to tell it to stop.
            await expect.poll(() => box.ready(), WAIT).toBe(2)
            expect(box.calls().filter(call => call[0] === 'new-session')).toHaveLength(1)
            expect(await sessions()).toEqual([expect.objectContaining({id: 'window-2', listening: true, started: expect.objectContaining({launch: handedDown.ORRERY_STARTED})})])
        })

        await test.step('stopped with no channel and no launcher to hear it, the next launcher stops it (ORR-789)', async () => {
            await window!.stop()
            window = undefined
            running.shift()!.kill('SIGKILL')
            await expect.poll(async () => (await api(request, 'get', '/launches')).launchers, WAIT).toBe(0)
            await api(request, 'post', '/sessions/window-2/stop', {}, OWNER)
            expect(box.calls().some(call => call[0] === 'kill-session')).toBe(false)
            running.push(box.startLauncher())
            await expect.poll(() => box.calls().some(call => call[0] === 'kill-session'), WAIT).toBe(true)
            await expect.poll(async () => (await sessions()).map(s => s.id), WAIT).toEqual([])
        })
    } finally {
        await window?.stop().catch(() => {})
        running.forEach(child => child.kill('SIGKILL'))
        await request.patch('/api/settings', {data: {starts: null}, headers: OWNER})
        // The visual spec's images show the whole sidebar, and a spec that isn't in them leaves nothing there.
        await request.delete(`/api/projects/${project}`, {headers: OWNER})
    }
})

// The same path in a second workspace (ORR-1311): Start session on a project there starts a session that works in that
// workspace alone. Its calls land on the issue there, only that workspace's Sessions page lists it, and a project in
// `default` is refused to it, though nothing but the workspace it was handed stops it asking.
test('a session started in a second workspace works there, and is refused a project in default', async ({page, request, baseURL}) => {
    test.setTimeout(120_000)
    const suffix = Date.now().toString(36)
    const made = await request.post('/api/workspaces', {data: {name: `Allotment ${suffix}`}, headers: OWNER})
    expect(made.ok(), await made.text()).toBeTruthy()
    const {id: workspace, name: workspaceName} = await made.json() as {id: string, name: string}
    const inWorkspace = {...OWNER, 'Orrery-Workspace': workspace}
    const boat = await request.post('/api/projects', {data: {name: `Greenhouse ${suffix}`, key: 'GRH'}, headers: {'Orrery-Actor': 'claude', 'Orrery-Workspace': workspace}})
    expect(boat.ok(), await boat.text()).toBeTruthy()
    const {id: project, name} = await boat.json() as {id: string, name: string}
    const {id: home} = await makeProject(request, {name: 'Homeplot', key: 'HMP'})
    const api = projectApi(project)
    const issue = async (id: string) => api(request, 'get', `/issues/${id}`) as Promise<{status: string, assignee?: string}>
    // The limit is the workspace's own (ORR-1313), and a new one starts nothing until the owner lets it.
    expect((await request.patch('/api/settings', {data: {starts: {limit: 5}}, headers: inWorkspace})).ok()).toBeTruthy()
    const box = machine(baseURL!, project)
    const running: ChildProcess[] = []
    let window: Awaited<ReturnType<typeof claude>> | undefined
    try {
        const {id: planted} = await api(request, 'post', '/issues', {title: 'Plant the tomatoes', status: 'todo'}, inWorkspace)
        expect(planted).toBe('GRH-1')
        const {id: away} = await projectApi(home)(request, 'post', '/issues', {title: 'Mow the lawn', status: 'todo'}, OWNER)
        running.push(box.startLauncher())
        await expect.poll(async () => (await api(request, 'get', '/launches')).launchers, WAIT).toBeGreaterThan(0)

        await test.step("Start session on the workspace's Sessions page has the launcher start one in it", async () => {
            await page.goto(`/w/${workspace}/sessions`)
            await page.getByRole('button', {name: 'Start session'}).first().click()
            const dialog = page.getByRole('dialog', {name: 'Start session'})
            // Only this workspace's projects are offered.
            await expect(dialog.getByRole('checkbox', {name})).toBeVisible()
            await expect(dialog.getByRole('checkbox', {name: 'Homeplot'})).toHaveCount(0)
            await dialog.getByRole('checkbox', {name}).check()
            await dialog.locator('[data-picker="Issue"]').click()
            await page.getByRole('option', {name: /GRH-1/}).click()
            await dialog.getByRole('button', {name: /^Start session/}).click()
            await expect.poll(() => box.calls().filter(call => call[0] === 'new-session').length, WAIT).toBe(1)
        })

        const started = box.calls().find(call => call[0] === 'new-session')!
        const handedDown = Object.fromEntries(started.flatMap((word, at) => started[at - 1] === '-e' ? [word.split(/=(.*)/s).slice(0, 2) as [string, string]] : []))
        expect(handedDown).toMatchObject({ORRERY_WORKSPACE: workspace, ORRERY_PROJECT: project})

        await test.step("its calls land on the workspace's issue", async () => {
            window = await claude(box.env, handedDown, 'window-1')
            await window.hook('SessionStart', 'window-1', {source: 'startup'})
            await expect.poll(async () => (await api(request, 'get', '/sessions') as Listed[]).find(s => s.id === 'window-1'), WAIT).toMatchObject({listening: true})
            await window.hook('UserPromptSubmit', 'window-1')
            const answered = await window.client.callTool({name: 'start_issue', arguments: {id: 'GRH-1', comment: 'Seedlings out.'}})
            expect(answered.isError, JSON.stringify(answered.content)).toBeFalsy()
            // A workspace's statuses are its own, their ids led by its id (ORR-1107).
            expect(await issue('GRH-1')).toMatchObject({status: `${workspace}-in-progress`, assignee: 'claude'})
            expect(await api(request, 'get', '/issues/GRH-1/comments')).toContainEqual(expect.objectContaining({created_by: 'claude', body: 'Seedlings out.'}))
        })

        await test.step("only the workspace's Sessions page lists it", async () => {
            await page.goto(`/w/${workspace}/sessions`)
            await expect(page.locator('#session-window-1')).toBeVisible({timeout: 30_000})
            await page.goto('/w/default/sessions')
            await expect(page.getByRole('button', {name: 'Start session'}).first()).toBeVisible({timeout: 30_000})
            await expect(page.locator('#session-window-1')).toHaveCount(0)
        })

        await test.step('a project in default is refused to it, read or written', async () => {
            // What its channel sends on each call: its session, and the workspace the launcher handed it.
            const as = {'Orrery-Actor': 'claude', 'Orrery-Session': 'window-1', 'Orrery-Workspace': handedDown.ORRERY_WORKSPACE!}
            const read = await request.get(`/api/projects/${home}/issues/${away}`, {headers: as})
            expect(read.status()).toBe(403)
            expect(await read.text()).toContain(`works in workspace ${workspace}`)
            const wrote = await request.post(`/api/projects/${home}/issues/${away}/comments`, {data: {body: 'Mowed.'}, headers: as})
            expect(wrote.status()).toBe(403)
            expect(await projectApi(home)(request, 'get', `/issues/${away}/comments`)).toEqual([])
        })
    } finally {
        await window?.stop().catch(() => {})
        running.forEach(child => child.kill('SIGKILL'))
        // Deleting the workspace takes its project with it.
        await request.delete(`/api/workspaces/${workspace}`, {data: {confirm: workspaceName}, headers: OWNER})
        await request.delete(`/api/projects/${home}`, {headers: OWNER})
    }
})
