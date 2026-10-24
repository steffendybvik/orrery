#!/usr/bin/env node
// Orrery's channel for Claude Code: an MCP server that runs inside a Claude session and pushes the
// owner's signals for one project into it ("focus on MSH-42"), even while the session is idle.
// Channels are a research preview: start the session with
//   claude --dangerously-load-development-channels server:orrery
// with this server registered as `orrery` in the repo's .mcp.json. ORRERY_PROJECT names the project
// (the folder's name by default); ORRERY_URL is where Orrery runs (http://localhost:9010 by default).
// Only stderr is for logs: stdout is the MCP connection.
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {homedir} from 'node:os'
import {basename, join} from 'node:path'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {claudeWindow} from './session.mjs'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9010').replace(/\/+$/, '')
const project = process.env.ORRERY_PROJECT ?? basename(process.cwd())
const api = `${base}/api/projects/${encodeURIComponent(project)}`
const log = (...parts) => console.error('[orrery channel]', ...parts)
// Which window this is, so Orrery can list it, aim a signal at it and know who got one.
const window = claudeWindow()
const who = new URLSearchParams(Object.entries({session: window.id, pid: window.pid, name: window.name}).filter(([, v]) => v).map(([k, v]) => [k, String(v)]))

const server = new Server({name: 'orrery', version: '1.0.0'}, {
    capabilities: {experimental: {'claude/channel': {}}},
    instructions: [
        `Orrery (${base}) keeps this repo's roadmap as project "${project}".`,
        'Its messages arrive as <channel source="orrery" ...> and come from the owner through Orrery.',
        `When one asks you to focus on an issue: read it (curl ${api}/issues/<id>), set it to doing and assign it to claude`,
        `(PATCH with header "Orrery-Actor: claude"), comment as the work moves, and set it to done when it ships.`,
        'When one asks you to work through a chunk, take its open issues one at a time, most urgent first, each that same way.',
        'When one brings the owner\'s comment on an issue, answer it with a comment on that issue (POST .../comments, same header), writing the JSON body from a file so Markdown survives the shell.',
        `The API is described at ${base}/api/guide.`,
    ].join(' '),
})
await server.connect(new StdioServerTransport())
// What Claude Code said about itself when it connected, so Orrery can tell a window started as a
// channel from one that only runs this server (whose messages Claude Code would drop).
await new Promise(resolve => setTimeout(resolve, 300))

/** Whether Claude Code took this server on as a channel: only a session started with
 * `--dangerously-load-development-channels server:orrery` shows its messages; otherwise it skips them.
 * Claude Code says which in its MCP log for this server (an undocumented file, read here as a hint:
 * `unknown` when it can't be found or doesn't say). */
function registered() {
    try {
        const dir = join(homedir(), 'Library', 'Caches', 'claude-cli-nodejs', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), 'mcp-logs-orrery')
        const newest = readdirSync(dir).map(name => join(dir, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
        const text = newest ? readFileSync(newest, 'utf8') : ''
        if (text.includes('Channel notifications registered')) return 'yes'
        if (text.includes('Channel notifications skipped')) return 'no'
    } catch {
        // Not on a Mac, or Claude Code keeps its logs elsewhere now.
    }
    return 'unknown'
}
await new Promise(resolve => setTimeout(resolve, 1200))
const channel = registered()
log(`registered as a channel: ${channel}`)
who.set('channel', channel)

/** Tells the session about a signal. */
async function deliver(signal) {
    const where = [signal.column, signal.priority, signal.chunk].filter(Boolean).join(', ')
    const issue = `${api}/issues/${encodeURIComponent(signal.issue)}`
    const content = !signal.issue
        ? [
            `${signal.createdBy} asks you to work through chunk ${signal.chunk}: ${signal.title} [${[signal.column, signal.priority].filter(Boolean).join(', ')}].`,
            signal.note ? `Note: ${signal.note}` : '',
            signal.issues.length
                ? `Its open issues, most urgent first:\n${signal.issues.map(i => `- ${i.id}: ${i.title} [${[i.column, i.priority].filter(Boolean).join(', ')}]`).join('\n')}`
                : 'It has no open issues left.',
            `Take them one at a time as you would a focus on each (doing, comments, done). Read the chunk with: curl ${api}/chunks/${encodeURIComponent(signal.chunk)}`,
        ].filter(Boolean).join('\n')
        : signal.kind === 'comment'
        ? [
            `${signal.createdBy} commented on ${signal.issue} (${signal.title}):`,
            '',
            signal.note.split('\n').map(line => `> ${line}`).join('\n'),
            '',
            `Answer with a comment on it: curl -s -X POST ${issue}/comments -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' --data @reply.json`,
            `(the whole thread: curl ${issue}/comments)`,
        ].join('\n')
        : [
            `${signal.createdBy} asks you to focus on ${signal.issue}: ${signal.title}${where ? ` [${where}]` : ''}.`,
            signal.note ? `Note: ${signal.note}` : '',
            `Read it with: curl ${issue}`,
        ].filter(Boolean).join('\n')
    const about = signal.issue ? {issue: signal.issue} : {chunk: signal.chunk}
    await server.notification({method: 'notifications/claude/channel', params: {content, meta: {project, ...about, kind: signal.kind}}})
    log(`delivered ${signal.kind} ${signal.issue ?? `chunk ${signal.chunk}`}`)
    // Tells Orrery it got here, so the owner sees which window has it.
    await fetch(`${api}/signals/${signal.id}/delivered?${who}`, {method: 'POST'}).catch(() => {})
}

// Listens to the project's signal stream, and after a drop picks up from the last one it saw.
let last = 0
for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
    try {
        const query = new URLSearchParams(who)
        if (last) query.set('after', String(last))
        const response = await fetch(`${api}/signals/stream?${query}`, {headers: {Accept: 'text/event-stream'}})
        if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}`)
        log(`listening for ${project}'s signals at ${base}`)
        wait = 1000
        let buffer = ''
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
            buffer += chunk
            let end
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, end)
                buffer = buffer.slice(end + 2)
                const field = name => block.split('\n').filter(l => l.startsWith(`${name}:`)).map(l => l.slice(name.length + 1).trimStart()).join('\n')
                if (field('event') !== 'signal') continue
                const signal = JSON.parse(field('data'))
                last = Math.max(last, Number(field('id')) || 0)
                await deliver(signal)
            }
        }
        log('the stream ended; reconnecting')
    } catch (error) {
        log(`can't reach Orrery (${error.message}); trying again in ${wait / 1000}s`)
    }
    await new Promise(resolve => setTimeout(resolve, wait))
}
