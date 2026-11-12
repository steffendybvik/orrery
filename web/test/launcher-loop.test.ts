import {execFileSync, spawn} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it, vi} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {chatOnly, lockedDown} from '../../channel/locked-down.mjs'
import {endSignal, spawnCoverage} from './spawn-coverage'

import {FAKE_TMUX} from './fake-tmux'

// The launcher's running part (ORR-700): the real launcher, spawned, against a stand-in orrery and a fake tmux that records
// its calls. It must never reach the real tmux, as a launcher adopts real sessions and kills them when it exits. So the
// fake is first on PATH, checked before each launcher starts, and TMUX_TMPDIR is a folder of its own, where even the real
// one would find no sessions. Its home is its own too, so the service's list and this machine's keys stay out of it.
const LAUNCHER = fileURLToPath(new URL('../../channel/orrery-launcher.mjs', import.meta.url))
const WAIT = {timeout: 10_000, interval: 25}
const ID = {a: 'aaaaaaaaaaaa', b: 'bbbbbbbbbbbb', c: 'cccccccccccc', d: 'dddddddddddd'}
const nameOf = (id: string, project = 'greenhouse') => `orrery-${project}-${id}`

type Launch = Record<string, unknown> & {id: string}
type Asked = {method: string, path: string, query: URLSearchParams, headers: Record<string, unknown>, body: string}

/** An orrery as far as a launcher sees it: its streams, which say they're ready, and what the launcher posts back. Its
 * launcher's stream is one for all its projects (ORR-1076), or with `older`, one each, as before that. */
async function standInOrrery(version: string, {older = false, mcp = false} = {}) {
    const asked: Asked[] = []
    const streams = new Map<string, Set<import('node:http').ServerResponse>>()
    /** The streams for all of a launcher's projects, as `/api/launches/stream` is, each with what it serves. */
    const wide = new Map<import('node:http').ServerResponse, string[]>()
    const refused = new Set<string>()
    const connectStreams = new Set<import('node:http').ServerResponse>()
    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://orrery')
        let body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            asked.push({method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, headers: req.headers, body})
            const stream = /^\/api\/projects\/([^/]+)\/launches\/stream$/.exec(url.pathname)
            if (stream) {
                res.writeHead(200, {'Content-Type': 'text/event-stream'})
                res.write(`event: ready\ndata: ${JSON.stringify({starts: {limit: 3, minutes: 0}, version, token: 'launcher-token'})}\n\n`)
                const open = streams.get(stream[1]!) ?? new Set()
                streams.set(stream[1]!, open.add(res))
                res.on('close', () => open.delete(res))
                return
            }
            if (url.pathname === '/api/launches/stream') {
                if (older) return void res.writeHead(404, {'Content-Type': 'application/json'}).end('{"statusMessage":"Not Found"}')
                const projects = (JSON.parse(url.searchParams.get('serve') ?? '[]') as {project: string}[]).map(entry => entry.project)
                res.writeHead(200, {'Content-Type': 'text/event-stream'})
                res.write(`event: ready\ndata: ${JSON.stringify({projects: Object.fromEntries(projects.map(p => [p, {starts: {limit: 3, minutes: 0}, token: 'launcher-token'}])), unknown: [], version})}\n\n`)
                wide.set(res, projects)
                res.on('close', () => wide.delete(res))
                return
            }
            if (url.pathname === '/api/connects/stream') {
                res.writeHead(200, {'Content-Type': 'text/event-stream'})
                res.write(`event: ready\ndata: ${JSON.stringify({token: 'connect-token', orrery: 'orr_stand_in'})}\n\n`)
                connectStreams.add(res)
                res.on('close', () => connectStreams.delete(res))
                return
            }
            // orrery's own MCP server (ORR-1102), only when it serves one.
            if (url.pathname === '/mcp' && mcp) return void res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({jsonrpc: '2.0', id: 0, result: {protocolVersion: '2025-06-18'}}))
            if (url.pathname.endsWith('/report')) return void res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({claimed: true}))
            const claim = /\/launches\/([^/]+)\/claim$/.exec(url.pathname)
            if (claim) return void res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify(refused.has(claim[1]!) ? {claimed: false} : {claimed: true, repo: 'https://github.com/hati/greenhouse'}))
            res.writeHead(200, {'Content-Type': 'application/json'}).end('{}')
        })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const paths = (end: string) => asked.filter(a => a.method === 'POST' && a.path.endsWith(end))
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        asked,
        refuse: (id: string) => refused.add(id),
        event: (event: string, data: unknown, project = 'greenhouse') => {
            streams.get(project)?.forEach(s => s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
            // On the one stream, each event names its project, as orrery's do.
            for (const [s, projects] of wide) if (projects.includes(project)) s.write(`event: ${event}\ndata: ${JSON.stringify({project, ...data as object})}\n\n`)
        },
        listening: (project = 'greenhouse') => (streams.get(project)?.size ?? 0) + [...wide.values()].filter(projects => projects.includes(project)).length,
        /** How many streams for all of a launcher's projects are open. */
        wideStreams: () => wide.size,
        /** What each launcher stream asked for serves, by project: its folder, or `home`. */
        serving: () => orreryServing(asked),
        connectEvent: (event: string, data: unknown) => connectStreams.forEach(s => s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
        connecting: () => connectStreams.size,
        connectReports: () => paths('/report').map(a => JSON.parse(a.body) as Record<string, unknown>),
        reported: () => paths('/launches/running').map(a => JSON.parse(a.body).launches as Record<string, unknown>[]),
        ended: () => paths('/ended').map(a => /launches\/([^/]+)\/ended/.exec(a.path)![1]!),
        claims: () => paths('/claim'),
        close: () => {
            server.closeAllConnections()
            server.close()
        },
    }
}

/** The folder each project was last asked to be served from, on either kind of launcher stream, or `home`. */
function orreryServing(asked: Asked[]): Record<string, string> {
    const serving: Record<string, string> = {}
    for (const a of asked) {
        const one = /^\/api\/projects\/([^/]+)\/launches\/stream$/.exec(a.path)
        if (one) serving[one[1]!] = a.query.get('home') === '1' ? 'home' : a.query.get('dir') ?? ''
        if (a.path === '/api/launches/stream') {
            for (const entry of JSON.parse(a.query.get('serve') ?? '[]') as {project: string, dir?: string, home?: boolean}[]) serving[entry.project] = entry.home ? 'home' : entry.dir ?? ''
        }
    }
    return serving
}

type Sessions = Record<string, Record<string, string>>
type Finishing = {onTestFinished: (done: () => unknown) => void}

/** A folder with a fake tmux, a stand-in orrery, and a way to start the launcher on them. */
async function bench({onTestFinished}: Finishing, sessions: Sessions = {}, {older = false, mcp = false} = {}) {
    // Its real path, as the launcher sees its own folder: on macOS the temp folder is behind a link.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orrery-launcher-loop-')))
    const [bin, fake, home, sockets, repo] = ['bin', 'fake', 'home', 'sockets', 'repo'].map(part => join(root, part)) as [string, string, string, string, string]
    for (const dir of [bin, fake, home, sockets, repo]) mkdirSync(dir)
    writeFileSync(join(bin, 'tmux'), FAKE_TMUX)
    chmodSync(join(bin, 'tmux'), 0o755)
    // A folder picker that chooses the repo, for either system, and a terminal that only says it opened.
    for (const name of ['osascript', 'zenity', 'x-terminal-emulator', 'claude']) {
        writeFileSync(join(bin, name), `#!${process.execPath}\nconst args = process.argv.slice(2).join(' ')\nif (/choose folder|--file-selection/.test(args)) console.log(${JSON.stringify(repo)})\nelse require('node:fs').appendFileSync(${JSON.stringify(join(fake, 'opened'))}, args + '\\n')\n`)
        chmodSync(join(bin, name), 0o755)
    }
    writeFileSync(join(fake, 'calls'), '')
    writeFileSync(join(fake, 'state.json'), JSON.stringify(sessions))
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string
    const orrery = await standInOrrery(version, {older, mcp})
    // `ps` is how it tells a live launcher, so the system's folders stay on PATH, after the fake.
    const env = {PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), TMUX_TMPDIR: sockets, FAKE_TMUX: fake, DISPLAY: ':0'}
    const children: ChildProcess[] = []
    onTestFinished(() => {
        children.forEach(child => child.kill(endSignal()))
        orrery.close()
    })
    const tmuxCalls = () => readFileSync(join(fake, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
    const list = join(home, '.config', 'orrery', 'launcher.json')
    return {
        orrery, repo, root, tmuxCalls, list,
        opened: () => existsSync(join(fake, 'opened')) ? readFileSync(join(fake, 'opened'), 'utf8') : '',
        state: () => JSON.parse(readFileSync(join(fake, 'state.json'), 'utf8')) as Sessions,
        called: (command: string) => tmuxCalls().filter(call => call[0] === command),
        writeList: (projects: Record<string, unknown>[]) => {
            mkdirSync(join(home, '.config', 'orrery'), {recursive: true})
            writeFileSync(list, JSON.stringify({projects}))
        },
        /** What stands for another launcher that's still running: `launcherAlive` goes by its command line. */
        otherLauncher() {
            const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/orrery/channel/orrery-launcher.mjs'], {stdio: 'ignore'})
            children.push(other)
            return String(other.pid)
        },
        /** Starts the launcher, as the owner's terminal would or, with `service`, as its service. Refuses if tmux here isn't the fake. */
        async start({service = false}: {service?: boolean} = {}) {
            expect(execFileSync('tmux', ['-V'], {env, encoding: 'utf8'}).trim()).toBe('tmux 3.4-fake')
            const launcher = spawn(process.execPath, [LAUNCHER, ...service ? ['--service'] : []], {
                cwd: repo,
                stdio: ['ignore', 'ignore', 'ignore'],
                env: {...env, ...spawnCoverage(), ...service ? {} : {ORRERY_PROJECT: 'greenhouse', ORRERY_URL: orrery.url}},
            })
            children.push(launcher)
            return launcher
        },
    }
}

/** The launch the launcher is offered on its stream. */
const launchOf = (id: string, more: Record<string, unknown> = {}): Launch => ({id, tmux: nameOf(id), after: 5, ...more})
/** What `claude` was started with, in the session's `new-session`, but the repo it's in (ORR-1070), which ends them all. */
const claudeArgs = (call: string[]) => call.slice(call.indexOf('claude') + 1, call.lastIndexOf('--append-system-prompt'))
/** The repo it was told it's in, in its system prompt. */
const toldRepo = (call: string[]) => call[call.lastIndexOf('--append-system-prompt') + 1]
const envOf = (call: string[]) => call.flatMap((arg, at) => arg === '-e' ? [call[at + 1]!] : [])

describe.concurrent("a launcher's own loop", {timeout: 40_000}, () => {
    describe('a launch', () => {
        it('that is claimed starts tmux, with the claim saying what it can lock down, and its token', async context => {
            const {orrery, repo, start, called, state} = await bench(context)
            await start()
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            orrery.event('launch', launchOf(ID.a, {hears: ['greenhouse', 'pantry'], person: 'hati', context: {note: 'start here'}}))
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_stops_at']).toBe('never'), WAIT)
            const [claim] = orrery.claims()
            expect(claim!.query.get('untrusted')).toBe('no-bash')
            expect(claim!.query.get('chat')).toBe('yes')
            expect(claim!.headers['orrery-launcher']).toBe('launcher-token')
            const [call] = called('new-session')
            expect(call!.slice(0, 6)).toEqual(['new-session', '-d', '-s', nameOf(ID.a), '-c', repo])
            expect(claudeArgs(call!)).toEqual(['--dangerously-load-development-channels', 'server:greenhouse', '--permission-mode', 'auto'])
            expect(envOf(call!)).toEqual(expect.arrayContaining([`ORRERY_URL=${orrery.url}`, 'ORRERY_PROJECT=greenhouse', `ORRERY_STARTED=${ID.a}`, 'ORRERY_AFTER=5', 'ORRERY_HEAR=greenhouse,pantry', 'ORRERY_PERSON=hati']))
            expect(envOf(call!).some(pair => pair.startsWith('ORRERY_UNTRUSTED') || pair.startsWith('ORRERY_CHAT'))).toBe(false)
            expect(state()[nameOf(ID.a)]).toMatchObject({'@orrery_launcher': expect.stringMatching(/^\d+$/), '@orrery_context': '{"note":"start here"}'})
        })

        it("tells the session which repo it's in, and its hook that it has", async context => {
            const {orrery, repo, start, called, state} = await bench(context)
            await start()
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            orrery.event('launch', launchOf(ID.a))
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_stops_at']).toBe('never'), WAIT)
            const [call] = called('new-session')
            // The bench's folder is in no git repo, so it's told so, and that the project's repo isn't here.
            expect(toldRepo(call!)).toBe(`orrery: this session's folder, ${repo}, isn't in a git repo. There's no repo to work in here; don't look for one.\nProject "greenhouse"'s repo in orrery is https://github.com/hati/greenhouse, and it isn't checked out in this folder.`)
            expect(envOf(call!)).toContain('ORRERY_REPO_TOLD=yes')
        })

        it('that is untrusted starts locked down, with no Bash, and its channel told so', async context => {
            const {orrery, repo, start, called, state} = await bench(context)
            await start()
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            orrery.event('launch', launchOf(ID.a, {untrusted: true}))
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_untrusted']).toBe('yes'), WAIT)
            const [call] = called('new-session')
            const args = claudeArgs(call!)
            expect(args.slice(2)).toEqual(lockedDown(repo, 'greenhouse'))
            expect(args[args.indexOf('--tools') + 1]).toBe('')
            expect(args).not.toContain('auto')
            expect(envOf(call!)).toContain('ORRERY_UNTRUSTED=yes')
        })

        it("that is the owner's chat starts with a chat's limits", async context => {
            const {orrery, repo, start, called, state} = await bench(context)
            await start()
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            orrery.event('launch', launchOf(ID.a, {chat: true}))
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_chat']).toBe('yes'), WAIT)
            const [call] = called('new-session')
            expect(claudeArgs(call!).slice(2)).toEqual(chatOnly(repo, 'greenhouse'))
            expect(envOf(call!)).toContain('ORRERY_CHAT=yes')
        })

        it("gets orrery's /mcp beside its channel when the orrery serves it, and its channel only the channel's own (ORR-1102)", async context => {
            const {orrery, start, called, state} = await bench(context, {}, {mcp: true})
            await start()
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            orrery.event('launch', launchOf(ID.a, {person: 'hati'}))
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_stops_at']).toBe('never'), WAIT)
            orrery.event('launch', launchOf(ID.b, {chat: true}))
            await vi.waitFor(() => expect(state()[nameOf(ID.b)]?.['@orrery_chat']).toBe('yes'), WAIT)
            orrery.event('launch', launchOf(ID.c, {untrusted: true}))
            await vi.waitFor(() => expect(state()[nameOf(ID.c)]?.['@orrery_untrusted']).toBe('yes'), WAIT)
            const [work, chat, untrusted] = called('new-session')
            const config = (call: string[]) => JSON.parse(call[call.indexOf('--mcp-config') + 1]!).mcpServers['greenhouse-api']
            const session = work![work!.indexOf('--session-id') + 1]!
            expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
            expect(config(work!)).toEqual({type: 'http', url: `${orrery.url}/mcp`, headers: {'Orrery-Actor': 'claude', 'Orrery-Session': session, 'Orrery-Person': 'hati'}})
            expect(claudeArgs(work!)).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__greenhouse-api']))
            expect(envOf(work!)).toContain('ORRERY_TOOLS=local')
            // The chat and an untrusted session too, saying so to /mcp as their channel does, whose rails hold them.
            const id = (call: string[]) => call[call.indexOf('--session-id') + 1]!
            expect(config(chat!).headers).toEqual({'Orrery-Actor': 'claude', 'Orrery-Session': id(chat!), 'Orrery-Chat': 'yes', 'Orrery-Launch': ID.b})
            expect(claudeArgs(chat!)).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__greenhouse-api']))
            expect(config(untrusted!).headers).toEqual({'Orrery-Actor': 'claude', 'Orrery-Session': id(untrusted!), 'Orrery-Untrusted': 'yes'})
            // Still its one --mcp-config, strict: the channel's entry (none in this repo) and /mcp's, nothing of the repo's.
            expect(claudeArgs(untrusted!).filter(a => a === '--mcp-config')).toHaveLength(1)
            expect(claudeArgs(untrusted!)).toEqual(expect.arrayContaining(['--strict-mcp-config', '--allowedTools', 'mcp__greenhouse', 'mcp__greenhouse-api']))
            for (const call of [chat!, untrusted!]) expect(envOf(call)).toContain('ORRERY_TOOLS=local')
        })

        it("keeps every tool in its channel when the orrery doesn't serve /mcp", async context => {
            const {orrery, start, called, state} = await bench(context)
            await start()
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            orrery.event('launch', launchOf(ID.a))
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_stops_at']).toBe('never'), WAIT)
            const [call] = called('new-session')
            expect(call).not.toContain('--mcp-config')
            expect(call).not.toContain('--session-id')
            expect(envOf(call!)).not.toContain('ORRERY_TOOLS=local')
        })

        it("that another launcher claimed starts nothing", async context => {
            const {orrery, start, called} = await bench(context)
            await start()
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            orrery.refuse(ID.a)
            orrery.event('launch', launchOf(ID.a))
            await vi.waitFor(() => expect(orrery.claims()).toHaveLength(1), WAIT)
            // Then one it can claim, which comes after on the same stream, so the first has been dealt with by then.
            orrery.event('launch', launchOf(ID.b))
            await vi.waitFor(() => expect(called('new-session')).toHaveLength(1), WAIT)
            expect(called('new-session')[0]).toContain(nameOf(ID.b))
        })
    })

    it('a stop event ends that session alone, and says it ended', async context => {
        const {orrery, start, state} = await bench(context)
        await start()
        await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
        for (const id of [ID.a, ID.b]) orrery.event('launch', launchOf(id))
        await vi.waitFor(() => expect(state()[nameOf(ID.b)]?.['@orrery_stops_at']).toBe('never'), WAIT)
        orrery.event('stop', {id: ID.a})
        await vi.waitFor(() => expect(orrery.ended()).toEqual([ID.a]), WAIT)
        expect(Object.keys(state())).toEqual([nameOf(ID.b)])
    })

    describe('starting up, with sessions already in tmux', () => {
        it("leaves one a live launcher runs alone, and another project's", async context => {
            const setup = await bench(context)
            const other = setup.otherLauncher()
            writeFileSync(join(setup.root, 'fake', 'state.json'), JSON.stringify({
                [nameOf(ID.a)]: {'@orrery_launcher': other, '@orrery_stops_at': 'never'},
                [nameOf(ID.b, 'pantry')]: {'@orrery_stops_at': 'never'},
                'not-orrerys': {},
            }))
            await setup.start()
            await vi.waitFor(() => expect(setup.orrery.reported()).toHaveLength(1), WAIT)
            expect(setup.orrery.reported()[0]).toEqual([])
            expect(setup.state()[nameOf(ID.a)]!['@orrery_launcher']).toBe(other)
            expect(Object.keys(setup.state())).toHaveLength(3)
            expect(setup.orrery.ended()).toEqual([])
        })

        it('stops one whose stop time is unknown, as nothing else would', async context => {
            const {orrery, start, state} = await bench(context, {[nameOf(ID.a)]: {'@orrery_launcher': '999999'}})
            await start()
            await vi.waitFor(() => expect(orrery.ended()).toEqual([ID.a]), WAIT)
            expect(state()).toEqual({})
        })

        it('takes one back with its stop time, context and marks, and tells orrery', async context => {
            const stops = '2099-01-02T03:04:05.000Z'
            const {orrery, start, state} = await bench(context, {
                [nameOf(ID.a)]: {'@orrery_launcher': '999999', '@orrery_stops_at': stops, '@orrery_context': '{"note":"keep going"}'},
                [nameOf(ID.b)]: {'@orrery_launcher': '999999', '@orrery_stops_at': 'never', '@orrery_untrusted': 'yes'},
                [nameOf(ID.c)]: {'@orrery_stops_at': 'never', '@orrery_chat': 'yes'},
            })
            await start()
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            expect(orrery.reported()[0]).toEqual([
                {id: ID.a, tmux: nameOf(ID.a), stops_at: stops, context: {note: 'keep going'}},
                {id: ID.b, tmux: nameOf(ID.b), untrusted: true},
                {id: ID.c, tmux: nameOf(ID.c), chat: true},
            ])
            expect(orrery.ended()).toEqual([])
            expect(Object.values(state()).map(s => s['@orrery_launcher'])).toEqual(Array(3).fill(expect.not.stringMatching(/^999999$/)))
        })
    })

    it('on SIGTERM stops only what it runs, and says so', async context => {
        const setup = await bench(context)
        const other = setup.otherLauncher()
        writeFileSync(join(setup.root, 'fake', 'state.json'), JSON.stringify({[nameOf(ID.b)]: {'@orrery_launcher': other, '@orrery_stops_at': 'never'}}))
        const launcher = await setup.start()
        await vi.waitFor(() => expect(setup.orrery.reported()).toHaveLength(1), WAIT)
        setup.orrery.event('launch', launchOf(ID.a))
        await vi.waitFor(() => expect(setup.state()[nameOf(ID.a)]?.['@orrery_stops_at']).toBe('never'), WAIT)
        const exited = new Promise(resolve => launcher.once('exit', resolve))
        launcher.kill('SIGTERM')
        expect(await exited).toBe(0)
        expect(setup.orrery.ended()).toEqual([ID.a])
        expect(Object.keys(setup.state())).toEqual([nameOf(ID.b)])
    })

    describe('as the service, following its list', () => {
        it('stops the sessions of a project taken off it, and not the others', async context => {
            const {orrery, repo, start, writeList, state} = await bench(context)
            const entry = (project: string) => ({url: orrery.url, project, dir: repo})
            writeList([entry('greenhouse'), entry('pantry')])
            await start({service: true})
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(2), WAIT)
            orrery.event('launch', launchOf(ID.a))
            orrery.event('launch', {id: ID.b, tmux: nameOf(ID.b, 'pantry'), after: 0}, 'pantry')
            await vi.waitFor(() => expect(state()[nameOf(ID.b, 'pantry')]?.['@orrery_stops_at']).toBe('never'), WAIT)
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_stops_at']).toBe('never'), WAIT)
            writeList([entry('pantry')])
            await vi.waitFor(() => expect(orrery.ended()).toEqual([ID.a]), WAIT)
            expect(Object.keys(state())).toEqual([nameOf(ID.b, 'pantry')])
            await vi.waitFor(() => expect(orrery.listening('greenhouse')).toBe(0), WAIT)
            await vi.waitFor(() => expect(orrery.listening('pantry')).toBe(1), WAIT)
        })

        it('serves all its projects on an orrery on one stream, connecting it again as the list changes (ORR-1076)', async context => {
            const {orrery, repo, start, writeList, state} = await bench(context)
            const entry = (project: string) => ({url: orrery.url, project, dir: repo})
            writeList([entry('greenhouse'), entry('pantry')])
            await start({service: true})
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(2), WAIT)
            expect(orrery.wideStreams()).toBe(1)
            expect(orrery.asked.filter(a => /^\/api\/projects\/[^/]+\/launches\/stream$/.test(a.path))).toEqual([])
            orrery.event('launch', {id: ID.b, tmux: nameOf(ID.b, 'pantry'), after: 0}, 'pantry')
            await vi.waitFor(() => expect(state()[nameOf(ID.b, 'pantry')]?.['@orrery_stops_at']).toBe('never'), WAIT)
            writeList([entry('greenhouse'), entry('pantry'), entry('orchard')])
            await vi.waitFor(() => expect(orrery.listening('orchard')).toBe(1), WAIT)
            // The stream before goes once the new one is ready, so pantry is never left with no launcher.
            await vi.waitFor(() => expect(orrery.wideStreams()).toBe(1), WAIT)
            expect(orrery.listening('pantry')).toBe(1)
            // Connecting again for the new set leaves the sessions running.
            expect(orrery.ended()).toEqual([])
            expect(Object.keys(state())).toEqual([nameOf(ID.b, 'pantry')])
        })

        it('serves each project on its own stream from an orrery on older code, which has no one stream (ORR-1076)', async context => {
            const {orrery, repo, start, writeList, state} = await bench(context, {}, {older: true})
            const entry = (project: string) => ({url: orrery.url, project, dir: repo})
            writeList([entry('greenhouse'), entry('pantry')])
            await start({service: true})
            await vi.waitFor(() => expect(orrery.listening('greenhouse')).toBe(1), WAIT)
            await vi.waitFor(() => expect(orrery.listening('pantry')).toBe(1), WAIT)
            orrery.event('launch', launchOf(ID.a))
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_stops_at']).toBe('never'), WAIT)
            writeList([entry('pantry')])
            await vi.waitFor(() => expect(orrery.ended()).toEqual([ID.a]), WAIT)
            await vi.waitFor(() => expect(orrery.listening('greenhouse')).toBe(0), WAIT)
            // Its old stream goes once the new one is ready, so for a moment it may have both.
            await vi.waitFor(() => expect(orrery.listening('pantry')).toBe(1), WAIT)
        })

        it('keeps the sessions of a project that only moved, serving it from its new folder', async context => {
            const {orrery, repo, root, start, writeList, state} = await bench(context)
            const moved = join(root, 'moved')
            mkdirSync(moved)
            writeList([{url: orrery.url, project: 'greenhouse', dir: repo}])
            await start({service: true})
            await vi.waitFor(() => expect(orrery.reported()).toHaveLength(1), WAIT)
            orrery.event('launch', launchOf(ID.a))
            await vi.waitFor(() => expect(state()[nameOf(ID.a)]?.['@orrery_stops_at']).toBe('never'), WAIT)
            writeList([{url: orrery.url, project: 'greenhouse', dir: moved}])
            await vi.waitFor(() => expect(orrery.serving().greenhouse).toBe(moved), WAIT)
            expect(orrery.ended()).toEqual([])
            expect(Object.keys(state())).toEqual([nameOf(ID.a)])
        })
    })
    it('as a service, sets up the folder chosen in its picker, serves it, and opens Claude there (ORR-708)', async context => {
        const {orrery, repo, start, writeList, list, opened} = await bench(context)
        writeList([{url: orrery.url, project: 'greenhouse', dir: repo}])
        await start({service: true})
        await vi.waitFor(() => expect(orrery.connecting()).toBe(1), WAIT)
        // With its machine's Bonjour name for a phone, a Mac's LocalHostName (ORR-874).
        const local = orrery.asked.find(a => a.path === '/api/connects/stream')!.query.get('local')
        if (process.platform === 'darwin') expect(local).toMatch(/^[\w-]+\.local$/)
        else expect(local).toBe('')
        orrery.connectEvent('pick', {id: 'c1'})
        await vi.waitFor(() => expect(orrery.connectReports().at(-1)).toMatchObject({state: 'picked', folder: 'repo'}), WAIT)
        expect(JSON.stringify(orrery.connectReports())).not.toContain(repo)
        orrery.connectEvent('write', {id: 'c1', projects: [{id: 'orchard', key: 'ORC'}], orrery: {id: 'orr_stand_in', environment: 'personal'}, terminal: 'terminal'})
        await vi.waitFor(() => expect(orrery.connectReports().at(-1)).toMatchObject({state: 'done', written: ['.mcp.json', '.claude/settings.json', 'CLAUDE.md']}), WAIT)
        expect(JSON.parse(readFileSync(join(repo, '.mcp.json'), 'utf8')).mcpServers['orrery-personal'].env).toMatchObject({ORRERY_URL: orrery.url, ORRERY_PROJECTS: 'orchard'})
        expect(JSON.parse(readFileSync(list, 'utf8')).projects.map((p: {project: string}) => p.project)).toEqual(['greenhouse', 'orchard'])
        expect(opened()).toMatch(/--dangerously-load-development-channels \W*server:orrery-personal/)
        await vi.waitFor(() => expect(orrery.listening('orchard')).toBe(1), WAIT)
    })

    it('in a terminal, takes no connect requests (ORR-708)', async context => {
        const {orrery, start} = await bench(context)
        await start()
        await vi.waitFor(() => expect(orrery.listening()).toBe(1), WAIT)
        expect(orrery.connecting()).toBe(0)
    })
})
