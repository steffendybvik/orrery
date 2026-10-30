import {spawn} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {mkdtempSync} from 'node:fs'
import {createServer} from 'node:http'
import type {IncomingHttpHeaders, Server, ServerResponse} from 'node:http'
import type {AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'

// The last step before the owner's words reach a session (ORR-701): the real channel, spawned, following a stand-in orrery
// and read over stdio as Claude Code reads it. Each one gets a home of its own, so it can't touch the launcher's list or
// this machine's keys, and CLAUDE_PID says which process is "its" claude: without that it would look up its own parents
// for the nearest `claude`, which under a Claude session is that session, and a `stop` would end it.
const CHANNEL = fileURLToPath(new URL('../../channel/orrery-channel.mjs', import.meta.url))
const WAIT = {timeout: 8000, interval: 20}

type Signal = Record<string, unknown>
type Heard = {content: string, meta: Record<string, string>}
type Asked = {method: string, url: URL, headers: IncomingHttpHeaders}

/** An orrery as far as a channel sees it: its settings, a stream that replays what's after `after` as the real one does,
 * and `delivered`. A request with no `session` is only the channel's check that the stream exists. */
async function standInOrrery() {
    const asked: Asked[] = []
    const streams = new Set<ServerResponse>()
    const sent: {id: number, text: string}[] = []
    let lastId = 0
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://orrery')
        asked.push({method: req.method ?? 'GET', url, headers: req.headers})
        if (url.pathname === '/api/settings') return void res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({id: 'stand-in', environment: 'test'}))
        if (url.pathname === '/api/signals/stream') {
            res.writeHead(200, {'Content-Type': 'text/event-stream'})
            res.flushHeaders()
            if (!url.searchParams.has('session')) return
            if (url.searchParams.has('after')) for (const {id, text} of sent) if (id > Number(url.searchParams.get('after'))) res.write(text)
            streams.add(res)
            req.on('close', () => streams.delete(res))
            return
        }
        if (req.method === 'POST') return void res.writeHead(200).end()
        res.writeHead(404).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const write = (text: string) => streams.forEach(stream => stream.write(text))
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        asked,
        /** A signal on the stream, under the next id unless it's given one; a later catch-up replays it. */
        signal(signal: Signal, id = ++lastId) {
            lastId = Math.max(lastId, id)
            const text = `id: ${id}\nevent: signal\ndata: ${JSON.stringify({id, project: 'greenhouse', created_by: 'Skoll', ...signal})}\n\n`
            sent.push({id, text})
            write(text)
            return id
        },
        event: (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        drop: () => streams.forEach(stream => stream.destroy()),
        listening: () => streams.size,
        listeners: () => asked.filter(a => a.url.pathname === '/api/signals/stream' && a.url.searchParams.has('session')),
        delivered: () => asked.filter(a => a.method === 'POST' && a.url.pathname.endsWith('/delivered')),
        close: () => {
            server.closeAllConnections()
            server.close()
        },
    }
}

async function startChannel(orrery: {url: string, listening: () => number}, env: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), 'orrery-channel-'))
    // What it takes for its claude, to end on a `stop`.
    const claude: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'})
    const heard: Heard[] = []
    const client = new Client({name: 'claude-code', version: '0'})
    client.fallbackNotificationHandler = async ({method, params}) => {
        if (method === 'notifications/claude/channel') heard.push(params as Heard)
    }
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [CHANNEL],
        cwd: home,
        stderr: 'ignore',
        env: {HOME: home, XDG_CONFIG_HOME: join(home, '.config'), ORRERY_URL: orrery.url, ORRERY_PROJECT: 'greenhouse', CLAUDE_CODE_SESSION_ID: 'window-1', CLAUDE_PID: String(claude.pid), ...env},
    })
    await client.connect(transport)
    // It doesn't end with its stdin, and closing alone would wait seconds to find that out.
    const stop = () => {
        claude.kill()
        if (transport.pid) process.kill(transport.pid)
        return client.close()
    }
    await vi.waitFor(() => expect(orrery.listening()).toBe(1), WAIT)
    /** The next thing it hears, once `count` have been. */
    const nth = async (count: number) => {
        await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(count), WAIT)
        return heard[count - 1]!
    }
    return {heard, nth, claude, stop}
}

const quote = (note: string) => `> ${note}`

describe('what a channel tells a session', {timeout: 30_000}, () => {
    let orrery: Awaited<ReturnType<typeof standInOrrery>>
    let channel: Awaited<ReturnType<typeof startChannel>>
    beforeAll(async () => {
        orrery = await standInOrrery()
        channel = await startChannel(orrery)
    })
    afterAll(async () => {
        await channel.stop()
        orrery.close()
    })

    /** The signal sent and what it was told of it, with its `delivered` having gone too. */
    async function told(signal: Signal) {
        const before = orrery.delivered().length
        const id = orrery.signal(signal)
        const said = await channel.nth(channel.heard.length + 1)
        await vi.waitFor(() => expect(orrery.delivered().length).toBe(before + 1), WAIT)
        return {said, id, delivered: orrery.delivered().at(-1)!}
    }
    const api = () => `${orrery.url}/api/projects/greenhouse`

    it('a message, to it alone, with its lines quoted', async () => {
        const {said} = await told({kind: 'message', note: 'Water them.\nThe jars too.'})
        expect(said.content).toBe([
            'Skoll sends you a message, to you alone:',
            '',
            quote('Water them.'),
            quote('The jars too.'),
            '',
            'Answer or act on it as it asks. If it turns into work worth tracking, put it in an issue as usual.',
        ].join('\n'))
        expect(said.meta).toEqual({project: 'greenhouse', kind: 'message'})
    })

    it("a schedule's message, naming the schedule", async () => {
        const {said} = await told({kind: 'message', schedule: 12, title: 'Morning round', note: 'Look at the seedlings.'})
        expect(said.content).toBe([
            'Skoll\'s schedule "Morning round" says:',
            '',
            quote('Look at the seedlings.'),
            '',
            'Do what it says. If it turns into work worth tracking, put it in an issue as usual.',
        ].join('\n'))
        expect(said.meta).toEqual({project: 'greenhouse', schedule: '12', kind: 'message'})
    })

    it('a comment, with how to answer it', async () => {
        const {said} = await told({kind: 'comment', issue: 'GRE-4', title: 'Label the jars', note: 'Which labels?'})
        expect(said.content).toBe([
            'Skoll commented on GRE-4 (Label the jars):',
            '',
            quote('Which labels?'),
            '',
            `Answer with a comment on it: curl -s -X POST ${api()}/issues/GRE-4/comments -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' --data @reply.json`,
            `(the whole thread: curl ${api()}/issues/GRE-4/comments)`,
        ].join('\n'))
        expect(said.meta).toEqual({project: 'greenhouse', issue: 'GRE-4', kind: 'comment'})
    })

    it('a focus on an issue, with where it stands and any note', async () => {
        const {said} = await told({kind: 'focus', issue: 'GRE-4', title: 'Label the jars', column: 'todo', priority: 'P1', note: 'Before lunch.'})
        expect(said.content).toBe([
            'Skoll asks you to focus on GRE-4: Label the jars [todo, P1].',
            'Note: Before lunch.',
            `Read it with: curl ${api()}/issues/GRE-4`,
        ].join('\n'))
        expect(said.meta).toEqual({project: 'greenhouse', issue: 'GRE-4', kind: 'focus'})
    })

    it('a focus on a chunk, with its issues most urgent first', async () => {
        const {said} = await told({kind: 'focus', chunk: '3', title: 'Moving parts', column: 'todo', priority: 'P2', issues: [{id: 'GRE-1', title: 'Oil them', column: 'todo', priority: 'P0'}, {id: 'GRE-2', title: 'Fit them', column: 'todo'}]})
        expect(said.content).toBe([
            'Skoll asks you to work through chunk 3: Moving parts [todo, P2].',
            'Its open issues, most urgent first:\n- GRE-1: Oil them [todo, P0]\n- GRE-2: Fit them [todo]',
            `Take them one at a time as you would a focus on each (in-progress, comments, done). Read the chunk with: curl ${api()}/chunks/3`,
        ].join('\n'))
        expect(said.meta).toEqual({project: 'greenhouse', chunk: '3', kind: 'focus'})
    })

    it('a chunk with nothing left says so', async () => {
        const {said} = await told({kind: 'focus', chunk: 'none', title: 'No chunk', status: 'todo', issues: []})
        expect(said.content).toContain('It has no todo issues left.')
        expect(said.content).toContain(`Read them with: curl '${api()}/issues?chunk=none'`)
    })

    it("uses a signal's prompt rather than its own wording", async () => {
        const {said} = await told({kind: 'focus', issue: 'GRE-4', title: 'Label the jars', prompt: 'The owner\'s template, filled in.'})
        expect(said.content).toBe('The owner\'s template, filled in.')
    })

    it("adds a signal's context once, and only to that signal", async () => {
        const {said} = await told({kind: 'message', note: 'Start here.', context: 'Standing words.'})
        expect(said.content.split('Standing words.')).toHaveLength(2)
        expect(said.content.endsWith('\n\nStanding words.')).toBe(true)
        const {said: next} = await told({kind: 'message', note: 'And then here.'})
        expect(next.content).not.toContain('Standing words.')
    })

    it('posts delivered after each one, saying which session has it', async () => {
        const {id, delivered} = await told({kind: 'message', note: 'Got this?'})
        expect(delivered.url.pathname).toBe(`/api/projects/greenhouse/signals/${id}/delivered`)
        expect(delivered.url.searchParams.get('session')).toBe('window-1')
    })
})

// Side by side, as each waits a second or two for its channel to start.
describe.concurrent('a channel and its stream', {timeout: 30_000}, () => {
    /** A stand-in orrery, and a channel on it, both gone when the test ends. */
    async function fresh({onTestFinished}: {onTestFinished: (done: () => unknown) => void}, env?: Record<string, string>, before?: (orrery: Awaited<ReturnType<typeof standInOrrery>>) => void) {
        const orrery = await standInOrrery()
        before?.(orrery)
        const channel = await startChannel(orrery, env)
        onTestFinished(async () => {
            await channel.stop()
            orrery.close()
        })
        return {orrery, ...channel}
    }

    it('after a drop, picks up from the last signal it saw, and tells nothing twice', async context => {
        const {orrery, heard, nth} = await fresh(context)
        expect(orrery.listeners()[0]!.url.searchParams.has('after')).toBe(false)
        orrery.signal({kind: 'message', note: 'first'})
        const seen = orrery.signal({kind: 'message', note: 'second'})
        await nth(2)
        orrery.drop()
        // Sent while it's away: the catch-up brings this one, and not the two it has.
        await vi.waitFor(() => expect(orrery.listening()).toBe(0), WAIT)
        orrery.signal({kind: 'message', note: 'while away'})
        await vi.waitFor(() => expect(orrery.listeners()).toHaveLength(2), WAIT)
        expect(orrery.listeners()[1]!.url.searchParams.get('after')).toBe(String(seen))
        expect((await nth(3)).content).toContain('while away')
        orrery.signal({kind: 'message', note: 'after it'})
        await nth(4)
        expect(heard.map(h => /^> (.*)$/m.exec(h.content)?.[1])).toEqual(['first', 'second', 'while away', 'after it'])
    })

    it('a started session catches up from ORRERY_AFTER, and says which launch it is', async context => {
        const {orrery, heard, nth} = await fresh(context, {ORRERY_STARTED: 'launch-1', ORRERY_AFTER: '7'}, before => {
            before.signal({kind: 'message', note: 'before its launch'}, 7)
            before.signal({kind: 'message', note: 'what it was started for'}, 8)
        })
        expect((await nth(1)).content).toContain('what it was started for')
        expect(heard).toHaveLength(1)
        const {searchParams} = orrery.listeners()[0]!.url
        expect(searchParams.get('after')).toBe('7')
        expect(searchParams.get('started')).toBe('launch-1')
        expect(searchParams.get('started_for')).toBe('greenhouse')
    })

    it("a started session's after of 0 still catches up, from the project's first signal", async context => {
        const {orrery, nth} = await fresh(context, {ORRERY_STARTED: 'launch-1', ORRERY_AFTER: '0'}, before => {
            before.signal({kind: 'message', note: 'its first'}, 1)
        })
        expect((await nth(1)).content).toContain('its first')
        expect(orrery.listeners()[0]!.url.searchParams.get('after')).toBe('0')
    })

    it('a stop event ends its claude', async context => {
        const {orrery, claude} = await fresh(context)
        const ended = new Promise(resolve => claude.once('exit', (_, signal) => resolve(signal)))
        orrery.event('stop', {})
        expect(await ended).toBe('SIGTERM')
    })

    it('a name event is told once, again when it changes, and goes on what it hears after', async context => {
        const {orrery, heard, nth} = await fresh(context)
        orrery.event('name', {name: 'orrery · Trym'})
        orrery.event('name', {name: 'orrery · Trym'})
        const first = await nth(1)
        expect(first.content).toContain('orrery calls this session orrery · Trym')
        expect(first.meta).toEqual({kind: 'name', session: 'orrery · Trym'})
        orrery.signal({kind: 'message', note: 'hello'})
        expect((await nth(2)).meta.session).toBe('orrery · Trym')
        orrery.event('name', {name: 'orrery · Vidar'})
        expect((await nth(3)).meta.session).toBe('orrery · Vidar')
        expect(heard.filter(h => h.meta.kind === 'name')).toHaveLength(2)
    })

    it('with ORRERY_KEY, sends the key on the stream and on delivered', async context => {
        const {orrery, nth} = await fresh(context, {ORRERY_KEY: 'orrery_agent_abc'})
        orrery.signal({kind: 'message', note: 'hello'})
        await nth(1)
        await vi.waitFor(() => expect(orrery.delivered()).toHaveLength(1), WAIT)
        expect(orrery.listeners()[0]!.headers.authorization).toBe('Bearer orrery_agent_abc')
        expect(orrery.delivered()[0]!.headers.authorization).toBe('Bearer orrery_agent_abc')
    })

    it('without one, sends none', async context => {
        const {orrery} = await fresh(context)
        expect(orrery.listeners()[0]!.headers.authorization).toBeUndefined()
    })
})

describe("the owner's chat", {timeout: 30_000}, () => {
    it('hears only messages, in its own wording, and is not told the rest arrived', async () => {
        const orrery = await standInOrrery()
        const {heard, nth, stop} = await startChannel(orrery, {ORRERY_CHAT: 'yes', ORRERY_STARTED: 'chat-1'})
        orrery.signal({kind: 'comment', issue: 'GRE-4', title: 'Label the jars', note: 'Not for the chat.'})
        orrery.signal({kind: 'focus', issue: 'GRE-4', title: 'Label the jars'})
        const id = orrery.signal({kind: 'message', note: 'What is left?\nBriefly.'})
        const said = await nth(1)
        expect(said.content).toBe(['Skoll, in the chat:', '', quote('What is left?'), quote('Briefly.'), '', 'Answer with the reply tool.'].join('\n'))
        await vi.waitFor(() => expect(orrery.delivered()).toHaveLength(1), WAIT)
        expect(orrery.delivered()[0]!.url.pathname).toContain(`/signals/${id}/delivered`)
        expect(heard).toHaveLength(1)
        expect(orrery.listeners()[0]!.url.searchParams.get('chat')).toBe('yes')
        await stop()
        orrery.close()
    })
})
