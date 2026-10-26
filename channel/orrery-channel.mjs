#!/usr/bin/env node
// Orrery's channel for Claude Code: an MCP server that runs inside a Claude session and pushes the
// owner's signals for a repo's projects into it ("focus on LAR-42"), even while the session is idle. It also
// gives the session tools for their roadmaps (tools.mjs), so it reads and writes issues without curl.
// Channels are a research preview: start the session with
//   claude --dangerously-load-development-channels server:orrery-<environment>
// with this server registered under that name in the repo's .mcp.json, one entry per Orrery (an older setup
// named it after its project, which works the same). ORRERY_PROJECTS lists the projects it serves (`hub,css,pos`),
// or `*` for every project on the Orrery as it starts; ORRERY_PROJECT names one, as older setups do; the folder's
// name by default. ORRERY_URL is where Orrery runs (http://localhost:9000 by default), and ORRERY_ID the Orrery
// it must be (its id, on its Connect page): another one at that address is refused, so a repo set up for one
// Orrery never writes to another. Only stderr is for logs: stdout is the MCP connection.
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {homedir} from 'node:os'
import {basename, join} from 'node:path'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js'
import {serverName} from './server-name.mjs'
import {claudeWindow} from './session.mjs'
import {follow} from './sse.mjs'
import {orreryTools, toolsFor} from './tools.mjs'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
const listed = (process.env.ORRERY_PROJECTS || process.env.ORRERY_PROJECT || basename(process.cwd())).split(',').map(p => p.trim()).filter(Boolean)
/** `*`: every project on the Orrery, known once it's reached. */
const every = listed.includes('*')
/** The projects it serves (filled in once the Orrery is reached, for `*`). */
const projects = every ? [] : listed
const apiOf = project => `${base}/api/projects/${encodeURIComponent(project)}`
const log = (...parts) => console.error('[orrery channel]', ...parts)
// Which window this is, so Orrery can list it, aim a signal at it and know who got one.
const window = claudeWindow()
// A session Orrery started (channel/orrery-launcher.mjs) says which launch it is, and catches up from the signal it's for.
// `stops`: it ends the session when the owner stops it from Orrery, which takes knowing its claude process.
const who = new URLSearchParams(Object.entries({session: window.id, pid: window.pid, name: window.name, stops: window.pid && 'yes'})
    .filter(([, v]) => v).map(([k, v]) => [k, String(v)]))
/** The project Orrery started the session for (the launcher says, in ORRERY_PROJECT), whose stream says so. */
const startedFor = () => process.env.ORRERY_STARTED && (projects.includes(process.env.ORRERY_PROJECT) ? process.env.ORRERY_PROJECT : projects[0])
/** Why it won't serve this Orrery (another than ORRERY_ID), once it knows. */
let refused = ''

const serves = every ? 'every project on it' : projects.length === 1 ? `project "${projects[0]}"` : `projects ${projects.map(p => `"${p}"`).join(', ')}`
const server = new Server({name: 'orrery', version: '1.0.0'}, {
    capabilities: {experimental: {'claude/channel': {}}, tools: {listChanged: true}},
    instructions: [
        `Orrery (${base}) keeps this repo's roadmap as ${serves}, and this server's tools read and write it`,
        '(issues, issue, start_issue, comment, finish_issue, create_issue, update_issue, chunks, releases, docs, doc, write_doc): use them instead of curl.',
        ...every || projects.length > 1 ? ['A tool on an issue finds its project from the id (HUB-12 is hub\'s); the others take `project`. Each <channel> block says its project.'] : [],
        'Its messages arrive as <channel ...> blocks and come from the owner through Orrery.',
        'When one asks you to focus on an issue: read it (issue), start it (start_issue), comment as the work moves (comment), and finish it when it ships (finish_issue).',
        'When one asks you to work through a chunk, take its open issues one at a time, most urgent first, each that same way.',
        'When one brings the owner\'s comment on an issue, answer it with a comment on that issue.',
        'When you need the owner to decide something or give feedback, comment with asks "decision" or "feedback": it waits at the top of their bell until they answer.',
        `When you open a pull request for an issue, link the issue's page (${base}/p/<project>/issues/<id>) in its description, so the owner can jump to it.`,
        'To call an outside service that needs a key, use egress with {{secret:NAME}} where the key goes (secrets lists the names): you never see the value, and never ask the owner for one.',
        `The full API is described at ${base}/api/guide.`,
    ].join(' '),
})
const callTool = orreryTools({root: `${base}/api`, projects, session: window.id})
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: toolsFor(projects)}))
server.setRequestHandler(CallToolRequestSchema, async request => {
    const why = refused || (!projects.length && `Orrery (${base}) hasn't been reached yet, so the projects it serves aren't known; try again shortly`)
    if (why) return {isError: true, content: [{type: 'text', text: why}]}
    return callTool(request.params.name, request.params.arguments ?? {})
})
await server.connect(new StdioServerTransport())
// What Claude Code said about itself when it connected, so Orrery can tell a window started as a
// channel from one that only runs this server (whose messages Claude Code would drop).
await new Promise(resolve => setTimeout(resolve, 300))

/** Whether Claude Code took this server on as a channel: only a session started with
 * `--dangerously-load-development-channels server:<name>` shows its messages; otherwise it skips them.
 * Claude Code says which in its MCP log for this server (an undocumented file, read here as a hint:
 * `unknown` when it can't be found or doesn't say). The log is kept by the server's name in .mcp.json,
 * which this server can't see, so it reads the newest log under the names it might have: its projects'
 * (`orrery-hub`, `hub`) and its Orrery's (`orrery-work`), and only without one of those the bare `orrery`, which in a
 * repo with a channel per project can be another Orrery's. The name that log is under is the server's, as far as it
 * can tell, for the command that restarts its session with the channel. */
function registered() {
    try {
        const cache = join(claudeCache(), process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
        const own = [...projects.flatMap(p => [`orrery-${p}`, p]), ...orrery.environment ? [serverName(orrery.environment)] : []]
        const logsOf = names => [...new Set(names)].flatMap(name => {
            try {
                const dir = join(cache, `mcp-logs-${name}`)
                return readdirSync(dir).map(file => ({name, file: join(dir, file), at: statSync(join(dir, file)).mtimeMs}))
            } catch {
                return []
            }
        })
        const logs = logsOf(own)
        const newest = (logs.length ? logs : logsOf(['orrery'])).sort((a, b) => b.at - a.at)[0]
        const text = newest ? readFileSync(newest.file, 'utf8') : ''
        const server = newest?.name
        if (text.includes('Channel notifications registered')) return {channel: 'yes', server}
        if (text.includes('Channel notifications skipped')) return {channel: 'no', server}
        return {channel: 'unknown', server}
    } catch {
        // Claude Code keeps its logs elsewhere now.
    }
    return {channel: 'unknown'}
}

/** Claude Code's cache folder, where its MCP logs are: the usual cache place on each system. */
function claudeCache() {
    if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'claude-cli-nodejs')
    if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'claude-cli-nodejs', 'Cache')
    return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'claude-cli-nodejs')
}
/** The Orrery at ORRERY_URL, once it answers: checked against ORRERY_ID, and for `*` its projects listed. Tries
 * until it's reached; one that isn't ORRERY_ID is refused for good, with why. */
const orrery = {}
async function reach() {
    for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
        try {
            const settings = await fetch(`${base}/api/settings`).then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`)))
            orrery.id = settings.id
            orrery.environment = settings.environment
            if (process.env.ORRERY_ID && settings.id && settings.id !== process.env.ORRERY_ID) {
                refused = `The Orrery at ${base} is ${settings.id} (${settings.environment ?? 'no environment'}), not ${process.env.ORRERY_ID}, the one this repo is set up for (ORRERY_ID): it won't be read or written. Point ORRERY_URL at the right one.`
                return
            }
            if (every) {
                const all = await fetch(`${base}/api/projects`).then(r => r.json())
                projects.push(...all.map(p => p.id))
                await server.notification({method: 'notifications/tools/list_changed'}).catch(() => {})
            }
            return
        } catch (error) {
            log(`can't reach Orrery (${error.message}); trying again in ${wait / 1000}s`)
            await new Promise(resolve => setTimeout(resolve, wait))
        }
    }
}
await Promise.all([reach(), new Promise(resolve => setTimeout(resolve, 1200))])
if (refused) {
    log(refused)
    // The tools say why; nothing is followed.
    await new Promise(() => {})
}
log(`serving ${projects.join(', ')}${orrery.id ? ` on ${orrery.id}` : ''}`)
const {channel, server: registeredAs} = registered()
log(`registered as a channel: ${channel}${registeredAs ? ` (as ${registeredAs})` : ''}`)
who.set('channel', channel)
if (registeredAs) who.set('server', registeredAs)

/** Tells the session about a signal on one of its projects. */
async function deliver(project, signal, query) {
    const api = apiOf(project)
    const where = [signal.column, signal.priority, signal.chunk].filter(Boolean).join(', ')
    const issue = `${api}/issues/${encodeURIComponent(signal.issue)}`
    // A focus comes with what to say (the owner's template, filled in); an older Orrery's doesn't.
    let content = signal.prompt
        ? signal.prompt
        : signal.kind === 'message' && !signal.schedule
        ? [
            `${signal.created_by} sends you a message, to you alone:`,
            '',
            signal.note.split('\n').map(line => `> ${line}`).join('\n'),
            '',
            'Answer or act on it as it asks. If it turns into work worth tracking, put it in an issue as usual.',
        ].join('\n')
        : signal.kind === 'message'
        ? [
            `${signal.created_by}'s schedule "${signal.title}" says:`,
            '',
            signal.note.split('\n').map(line => `> ${line}`).join('\n'),
            '',
            'Do what it says. If it turns into work worth tracking, put it in an issue as usual.',
        ].join('\n')
        : !signal.issue
        ? [
            `${signal.created_by} asks you to work through ${signal.status ? `the ${signal.status} issues in ` : ''}chunk ${signal.chunk}: ${signal.title} [${[signal.column, signal.priority].filter(Boolean).join(', ')}].`,
            signal.note ? `Note: ${signal.note}` : '',
            signal.issues.length
                ? `Its ${signal.status ?? 'open'} issues, most urgent first:\n${signal.issues.map(i => `- ${i.id}: ${i.title} [${[i.column, i.priority].filter(Boolean).join(', ')}]`).join('\n')}`
                : `It has no ${signal.status ?? 'open'} issues left.`,
            `Take them one at a time as you would a focus on each (in-progress, comments, done). Read ${signal.chunk === 'none' ? `them with: curl '${api}/issues?chunk=none'` : `the chunk with: curl ${api}/chunks/${encodeURIComponent(signal.chunk)}`}`,
        ].filter(Boolean).join('\n')
        : signal.kind === 'comment'
        ? [
            `${signal.created_by} commented on ${signal.issue} (${signal.title}):`,
            '',
            signal.note.split('\n').map(line => `> ${line}`).join('\n'),
            '',
            `Answer with a comment on it: curl -s -X POST ${issue}/comments -H 'Content-Type: application/json' -H 'Orrery-Actor: claude' --data @reply.json`,
            `(the whole thread: curl ${issue}/comments)`,
        ].join('\n')
        : [
            `${signal.created_by} asks you to focus on ${signal.issue}: ${signal.title}${where ? ` [${where}]` : ''}.`,
            signal.note ? `Note: ${signal.note}` : '',
            `Read it with: curl ${issue}`,
        ].filter(Boolean).join('\n')
    // What the owner gave the session as they started it goes with every signal, so it never drifts out.
    if (signal.context) content = `${content}\n\n${signal.context}`
    const about = signal.issue ? {issue: signal.issue} : signal.chunk ? {chunk: signal.chunk} : {schedule: String(signal.schedule)}
    await server.notification({method: 'notifications/claude/channel', params: {content, meta: {project, ...about, kind: signal.kind}}})
    log(`delivered ${signal.kind} ${signal.issue ?? (signal.chunk ? `chunk ${signal.chunk}` : `from schedule ${signal.schedule}`)}`)
    // Tells Orrery it got here, so the owner sees which window has it.
    await fetch(`${api}/signals/${signal.id}/delivered?${query}`, {method: 'POST'}).catch(() => {})
}

/** The owner stopped this session from Orrery: ends its claude process, which takes this server with it. */
function quit() {
    if (!window.pid) return log("asked to stop, but can't tell which claude process this is")
    log(`stopping the session (claude, pid ${window.pid}), as the owner asked`)
    try {
        process.kill(window.pid, 'SIGTERM')
    } catch (error) {
        log(`couldn't stop it: ${error.message}`)
    }
}

// Listens to each project's signal stream, and after a drop picks up from the last one it saw. A session Orrery
// started catches up on its project's from its launch's `after`, 0 included (a project's first signal).
await Promise.all(projects.map(project => {
    const started = project === startedFor()
    let last = started ? Number(process.env.ORRERY_AFTER) || 0 : 0
    const catchUp = started && process.env.ORRERY_AFTER !== undefined
    const query = new URLSearchParams(who)
    if (started) query.set('started', process.env.ORRERY_STARTED)
    return follow({
        url: () => {
            const asked = new URLSearchParams(query)
            if (last || catchUp) asked.set('after', String(last))
            return `${apiOf(project)}/signals/stream?${asked}`
        },
        onOpen: () => log(`listening for ${project}'s signals at ${base}`),
        onEvent: async ({event, data, id}) => {
            if (event === 'stop') return quit()
            if (event !== 'signal') return
            last = Math.max(last, Number(id) || 0)
            await deliver(project, JSON.parse(data), query)
        },
        log: (...parts) => log(`${project}:`, ...parts),
    })
}))
