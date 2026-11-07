#!/usr/bin/env node
// orrery's channel for Claude Code: an MCP server that runs inside a Claude session and pushes the
// owner's signals for a repo's projects into it ("focus on GRE-42"), even while the session is idle. It also
// gives the session tools for their roadmaps (tools.mjs), so it reads and writes issues without curl.
// Channels are a research preview: start the session with
//   claude --dangerously-load-development-channels server:orrery-<environment>
// with this server registered under that name in the repo's .mcp.json, one entry per orrery (an older setup
// named it after its project, which works the same). ORRERY_PROJECTS lists the projects it serves (`hub,css,pos`),
// or `*` for every project on the orrery as it starts; ORRERY_PROJECT names one, as older setups do;
// with neither, every project, a call taking the session's own (ORR-1068). ORRERY_HEAR narrows that to the ones named
// (the launcher sets it for a session started for some of the repo's projects); one it doesn't serve is let go. ORRERY_URL is where orrery runs (http://localhost:9000 by default), and ORRERY_ID the orrery
// it must be (its id, on its Connect page): another one at that address is refused, so a repo set up for one
// orrery never writes to another. Opened in a repo by hand, it puts the repo on the launcher's list when the launcher's
// pick-up is on (ORR-599). Only stderr is for logs: stdout is the MCP connection.
import {readdirSync, readFileSync, statSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Server} from '@modelcontextprotocol/sdk/server/index.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js'
import {authHeaders} from './credentials.mjs'
import {pickedUpMessage, pickUpRepo} from './pick-up.mjs'
import {narrowed} from './repo-channels.mjs'
import {addToList, projectAt, readConfig} from './launcher-service.mjs'
import {serverName} from './server-name.mjs'
import {signalWords} from './signal-words.mjs'
import {claudeWindow} from './session.mjs'
import {instructionsFor} from './instructions.mjs'
import {follow} from './sse.mjs'
import {orreryTools, toolsFor} from './tools.mjs'
import {BOOTSTRAP, VERSION, olderThan} from './version.mjs'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
// With neither, every project (ORR-1068): the folder's name is no project's, so a call names its own, or takes the
// session's (`own`).
const listed = (process.env.ORRERY_PROJECTS || process.env.ORRERY_PROJECT || '*').split(',').map(p => p.trim()).filter(Boolean)
/** The projects it serves, as ORRERY_HEAR narrows them: for `*`, those named (`null`, every project on the orrery,
 * known once it's reached). */
const hearing = narrowed(listed, process.env.ORRERY_HEAR)
const every = hearing === null
/** The projects it serves (filled in once the orrery is reached, for `*`). */
const projects = every ? [] : hearing
const apiOf = project => `${base}/api/projects/${encodeURIComponent(project)}`
const log = (...parts) => console.error('[orrery channel]', ...parts)
// Which window this is, so orrery can list it, aim a signal at it and know who got one.
const window = claudeWindow()
// A session orrery started (channel/orrery-launcher.mjs) says which launch it is, and catches up from the signal it's for.
// `stops`: it ends the session when the owner stops it from orrery, which takes knowing its claude process.
/** Started for an untrusted schedule's run (the launcher says, in ORRERY_UNTRUSTED): its streams and writes say so. */
const untrusted = process.env.ORRERY_UNTRUSTED === 'yes'
/** Started for the owner's chat (the launcher says, in ORRERY_CHAT): the launch, which is the chat's id. It answers in
 * the chat, and says so on all it sends. */
const chat = process.env.ORRERY_CHAT === 'yes' ? process.env.ORRERY_STARTED : undefined
/** Started as a global session (the launcher says, in ORRERY_GLOBAL, ORR-1079): it has no project of its own. */
const globalSession = process.env.ORRERY_GLOBAL === 'yes' && !chat
/** What a chat's tools reach (ORR-1063): every project its channel lists, not only the one it hears, so it can ask for
 * a schedule or a doc on another, its own when it names none. Filled in once the orrery is reached, for `*`. */
const reached = chat && !every ? (listed.includes('*') ? [] : [...new Set(listed)]) : projects
const who = new URLSearchParams(Object.entries({session: window.id, pid: window.pid, name: window.name, stops: window.pid && 'yes', untrusted: untrusted && 'yes', chat: chat && 'yes', version: VERSION})
    .filter(([, v]) => v).map(([k, v]) => [k, String(v)]))
/** The project the launcher's list maps this folder to, for a session orrery didn't start (ORR-1068); `link_folder` sets it. */
let mapped = process.env.ORRERY_STARTED ? undefined : projectAt(process.cwd(), base)
/** The project orrery started the session for (the launcher says, in ORRERY_PROJECT), whose stream says so. */
const startedFor = () => process.env.ORRERY_STARTED && (projects.includes(process.env.ORRERY_PROJECT) ? process.env.ORRERY_PROJECT : projects[0])
/** Why it won't serve this orrery (another than ORRERY_ID), once it knows. */
let refused = ''

const serves = every ? 'every project on it' : projects.length === 1 ? `project "${projects[0]}"` : `projects ${projects.map(p => `"${p}"`).join(', ')}`
const server = new Server({name: 'orrery', version: VERSION}, {
    capabilities: {experimental: {'claude/channel': {}}, tools: {listChanged: true}},
    instructions: instructionsFor({base, serves, chat: !!chat, untrusted, several: every || projects.length > 1, global: globalSession,
        unlinked: !chat && !untrusted && !process.env.ORRERY_STARTED && !mapped}),
})
// Each call's answer, for the Context page's "so far" (ORR-549): sent plain, as `delivered` is, so the chat's and an
// untrusted session's guards don't take it for one of their writes.
/** Whose this session is, from the user's environment (or the launcher's, for one it started): sent on every request, so
 * it holds across an orrery restart and a `/clear`. */
const person = process.env.ORRERY_PERSON?.trim() || undefined
// With auth on, its agent key decides who it is, and a person key here stops it starting (ORR-664).
const personHeaders = {...person ? {'Orrery-Person': person} : {}, ...authHeaders(base)}
const reportCall = (tool, text) => window.id && fetch(`${base}/api/sessions/${encodeURIComponent(window.id)}/calls`,
    {method: 'POST', headers: {'Content-Type': 'application/json', ...personHeaders}, body: JSON.stringify({tool, text})}).catch(() => {})
// The groups of tools this session asked for with more_tools (ORR-625): listed from then on.
const loaded = new Set()
const loadTools = async group => {
    loaded.add(group)
    await server.notification({method: 'notifications/tools/list_changed'}).catch(() => {})
}
/** The project a call that names none is on (ORR-1068), when it serves several: a chat's own; a session orrery started,
 * the one it was started for; else the one the launcher's list maps this folder to. None when it serves none of
 * those, and the call says which. Read at each call, as `*` knows its projects only once the orrery is reached. */
const own = () => {
    if (globalSession) return undefined
    const project = process.env.ORRERY_STARTED ? startedFor() : mapped
    return project && reached.includes(project) ? project : undefined
}
/** Links this session's folder to `project` on this orrery (`link_folder`, ORR-1071): puts it on the launcher's list, as
 * Connect a repo does, so its sessions report there and default to it, and the launcher serves it from here. A project
 * served from another folder stays there unless `move`, as linking here moves its sessions here. */
function link(project, {move}) {
    const dir = process.cwd()
    const elsewhere = readConfig().projects.find(entry => entry.url?.replace(/\/+$/, '') === base && entry.project === project && entry.dir !== dir)
    if (elsewhere && !move) throw new Error(`${project} is served from ${elsewhere.dir}, and linking it here moves the sessions orrery starts for it here: ask the user, and call again with move: true if they want that`)
    addToList([{url: base, project, dir}], dir)
    mapped = projectAt(dir, base)
    return `Linked ${dir} to ${project}${elsewhere ? ` (it was served from ${elsewhere.dir})` : ''}. Sessions here report to it${mapped ? ' and default to it' : ''}, and orrery can start sessions here.${mapped ? '' : ' This folder serves other projects too, so calls here still name theirs.'}`
}
const callTool = orreryTools({root: `${base}/api`, projects: reached, home: own, session: window.id, person, auth: authHeaders(base), untrusted, chat, report: reportCall, load: loadTools, link})
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools: toolsFor(reached, {chat: !!chat, untrusted, loaded: [...loaded], home: own()})}))
server.setRequestHandler(CallToolRequestSchema, async request => {
    const why = refused || (!projects.length && `orrery (${base}) hasn't been reached yet, so the projects it serves aren't known; try again shortly`)
    if (why) return {isError: true, content: [{type: 'text', text: why}]}
    // One use of the tool, for App settings' Usage (ORR-881): orrery counts it only while the owner has counting on.
    if (!untrusted) fetch(`${base}/api/usage`, {method: 'POST', headers: {'Content-Type': 'application/json', ...personHeaders}, body: JSON.stringify({feature: `tool:${request.params.name}`})}).catch(() => {})
    return callTool(request.params.name, request.params.arguments ?? {})
})
await server.connect(new StdioServerTransport())
// What Claude Code said about itself when it connected, so orrery can tell a window started as a
// channel from one that only runs this server (whose messages Claude Code would drop).
await new Promise(resolve => setTimeout(resolve, 300))

/** Whether Claude Code took this server on as a channel: only a session started with
 * `--dangerously-load-development-channels server:<name>` shows its messages; otherwise it skips them.
 * Claude Code says which in its MCP log for this server (an undocumented file, read here as a hint:
 * `unknown` when it can't be found or doesn't say). The log is kept by the server's name in .mcp.json,
 * which this server can't see, so it reads the newest log under the names it might have: its projects'
 * (`orrery-hub`, `hub`) and its orrery's (`orrery-work`), and only without one of those the bare `orrery`, which in a
 * repo with a channel per project can be another orrery's. The name that log is under is the server's, as far as it
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
/** The orrery at ORRERY_URL, once it answers: checked against ORRERY_ID, and for `*` its projects listed. Tries
 * until it's reached; one that isn't ORRERY_ID is refused for good, with why. */
const orrery = {}
async function reach() {
    for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
        try {
            const settings = await fetch(`${base}/api/settings`, {headers: personHeaders}).then(r => r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${r.statusText}`)))
            orrery.id = settings.id
            // Which orrery it's run as is `GET /api/machine` since ORR-954; an older orrery has it in its settings.
            const machine = await fetch(`${base}/api/machine`, {headers: personHeaders}).then(r => r.ok ? r.json() : {}).catch(() => ({}))
            settings.environment = machine.environment ?? settings.environment
            orrery.environment = settings.environment
            if (process.env.ORRERY_ID && settings.id && settings.id !== process.env.ORRERY_ID) {
                refused = `The orrery at ${base} is ${settings.id} (${settings.environment ?? 'no environment'}), not ${process.env.ORRERY_ID}, the one this repo is set up for (ORRERY_ID): it won't be read or written. Point ORRERY_URL at the right one.`
                return
            }
            // A chat on `*` that hears one project still reaches them all.
            const reachesAll = reached !== projects && listed.includes('*')
            if (every || reachesAll) {
                const all = await fetch(`${base}/api/projects`, {headers: personHeaders}).then(r => r.json())
                if (every) projects.push(...all.map(p => p.id))
                if (reachesAll) reached.push(...all.map(p => p.id))
                await server.notification({method: 'notifications/tools/list_changed'}).catch(() => {})
            }
            return
        } catch (error) {
            log(`can't reach orrery (${error.message}); trying again in ${wait / 1000}s`)
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

/** Pick-up (ORR-599, pick-up.mjs): puts this repo's projects on the launcher's list, as `--install` there would, so
 * orrery can start sessions here too, and says so once. */
async function pickUpHere() {
    const added = await pickUpRepo(process.cwd())
    const content = pickedUpMessage(added, BOOTSTRAP ? `${BOOTSTRAP} launcher` : fileURLToPath(new URL('./orrery-launcher.mjs', import.meta.url)))
    if (!content) return
    log(`put ${added.map(entry => entry.project).join(', ')} on the launcher's list (pick-up)`)
    await server.notification({method: 'notifications/claude/channel', params: {content, meta: {kind: 'pick-up'}}})
}
await pickUpHere().catch(error => log(`couldn't put this repo on the launcher's list: ${error.message}`))

/** Tells the session about a signal on one of its projects. A chat hears only the owner's messages in it. */
async function deliver(project, signal, query) {
    if (chat && signal.kind !== 'message') return
    const api = apiOf(project)
    let content = signalWords(signal, {api, chat: !!chat})
    // What the owner gave the session as they started it, with the first signal after it connects (its hook gives it too).
    if (signal.context) content = `${content}\n\n${signal.context}`
    const about = signal.issue ? {issue: signal.issue} : signal.milestone ? {milestone: signal.milestone} : signal.schedule ? {schedule: String(signal.schedule)} : {}
    await server.notification({method: 'notifications/claude/channel', params: {content, meta: {project, ...about, kind: signal.kind, ...named ? {session: named} : {}}}})
    log(`delivered ${signal.kind} ${signal.issue ?? (signal.milestone ? `milestone ${signal.milestone}` : signal.schedule ? `from schedule ${signal.schedule}` : 'to this session')}`)
    // Tells orrery it got here, so the owner sees which window has it.
    await fetch(`${api}/signals/${signal.id}/delivered?${query}`, {method: 'POST', headers: personHeaders}).catch(() => {})
}

/** What orrery calls this session (`orrery · …`), as its stream says: every signal carries it, and Claude hears it
 * once, and again when it changes. */
let named = ''
async function nameIs(name) {
    if (!name || name === named) return
    named = name
    log(`orrery calls this session ${name}`)
    await server.notification({method: 'notifications/claude/channel', params: {
        content: `orrery calls this session ${name}: that's how the owner sees it on the Sessions page and in the sidebar.`,
        meta: {kind: 'name', session: name},
    }})
}

/** An orrery that takes only newer channels than this (ORR-965, its stream's `ready` saying `oldest`): said plainly, as
 * the session's first words and on the log, rather than half working. Once for each oldest it hears. */
let toldOldest = ''
async function oldestIs(oldest) {
    if (!oldest || oldest === toldOldest || !olderThan(VERSION, oldest)) return
    toldOldest = oldest
    const fix = BOOTSTRAP ? 'restart this session to load the newer channel' : 'update the checkout this channel runs from (git pull), then restart this session'
    log(`this channel runs ${VERSION}, and the orrery at ${base} takes ${oldest} or newer`)
    await server.notification({method: 'notifications/claude/channel', params: {
        content: `This session's orrery channel runs ${VERSION}, and the orrery at ${base} takes channels from ${oldest} on, so some of what it sends may not arrive or work. Tell the owner, and ask them to ${fix}.`,
        meta: {kind: 'version', version: VERSION, oldest},
    }})
}

/** The owner stopped this session from orrery: ends its claude process, which takes this server with it. */
function quit() {
    if (!window.pid) return log("asked to stop, but can't tell which claude process this is")
    log(`stopping the session (claude, pid ${window.pid}), as the owner asked`)
    try {
        process.kill(window.pid, 'SIGTERM')
    } catch (error) {
        log(`couldn't stop it: ${error.message}`)
    }
}

/** Follows one stream of signals, and after a drop picks up from the last one it saw. A session orrery started catches
 * up on its project's from its launch's `after`, 0 included (a project's first signal). */
function listen({url, started, label}) {
    let last = started ? Number(process.env.ORRERY_AFTER) || 0 : 0
    const catchUp = started && process.env.ORRERY_AFTER !== undefined
    const query = new URLSearchParams(who)
    if (started) query.set('started', process.env.ORRERY_STARTED)
    return follow({
        headers: personHeaders,
        url: () => {
            const asked = new URLSearchParams(query)
            if (last || catchUp) asked.set('after', String(last))
            return url(asked)
        },
        onOpen: () => log(`listening for ${label}'s signals at ${base}`),
        onEvent: async ({event, data, id}) => {
            if (event === 'stop') return quit()
            if (event === 'name') return nameIs(JSON.parse(data).name)
            if (event === 'ready') return oldestIs(JSON.parse(data).oldest)
            if (event !== 'signal') return
            last = Math.max(last, Number(id) || 0)
            const signal = JSON.parse(data)
            await deliver(signal.project, signal, new URLSearchParams(who))
        },
        log: (...parts) => log(`${label}:`, ...parts),
    })
}

// One stream for all its projects (`*` picks up a project made later too). An orrery from before there was one
// answers 404 there, and then each project's stream is followed on its own.
const single = await fetch(`${base}/api/signals/stream`, {headers: personHeaders}).then(r => r.status !== 404, () => true)
if (single) {
    const names = every ? '*' : projects.join(',')
    await listen({
        url: asked => {
            asked.set('projects', names)
            if (startedFor()) asked.set('started_for', startedFor())
            return `${base}/api/signals/stream?${asked}`
        },
        started: !!startedFor(),
        label: every ? 'every project' : projects.join(', '),
    })
} else {
    await Promise.all(projects.map(project => listen({
        url: asked => `${apiOf(project)}/signals/stream?${asked}`,
        started: project === startedFor(),
        label: project,
    })))
}
