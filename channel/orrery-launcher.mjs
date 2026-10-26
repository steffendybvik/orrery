#!/usr/bin/env node
// Orrery's launcher: starts Claude sessions for a project when Orrery asks, so work gets done without
// anyone opening a terminal. Install it once in each project's repo (where .mcp.json registers the channel),
// as a background service that starts at login and serves every project installed:
//   node /path/to/orrery/channel/orrery-launcher.mjs --install      (--uninstall takes the repo's project off)
// or run it in a terminal for the repo's project alone, for as long as the terminal stays open:
//   ORRERY_PROJECT=shop node /path/to/orrery/channel/orrery-launcher.mjs
// The projects are ORRERY_PROJECT, else the channel's in .mcp.json (its ORRERY_PROJECTS, each of them, or its
// ORRERY_PROJECT), else the folder's name; the Orrery is ORRERY_URL. Orrery asks only for a project the owner lets have sessions started (its Sessions tab): when the
// owner's signal finds nobody listening, or the owner presses Start session, within the project's limit.
// Each session runs in a detached tmux session (`tmux attach -t <name>` to watch it), with the channel, in
// ORRERY_PERMISSION_MODE (`auto` by default, as nobody is there to answer a prompt), and is stopped after the
// project's minutes, or when the owner stops it from Orrery. Between pieces of work Orrery has it `/clear`ed, for a
// fresh context. With several launchers on a project, the first
// to claim a launch starts it. Stopping the launcher stops the sessions it started; one that dies instead (a
// crash, the service restarting it) takes its project's sessions back when it starts again, as each keeps its
// stop time in tmux, and tells Orrery which it runs whenever it connects. It answers the warning
// Claude Code shows for the channel flag on every start (the channel is the repo's own); run the channel
// command once by hand in the repo first, to accept the folder's trust prompt, which it leaves to you.
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {basename, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {configFile, install, readConfig, uninstall} from './launcher-service.mjs'
import {follow} from './sse.mjs'

const mode = process.env.ORRERY_PERMISSION_MODE || 'auto'
const log = (...parts) => console.error('[orrery launcher]', ...parts)
const tmux = (...args) => execFileSync('tmux', args, {encoding: 'utf8'}).trim()

/** The channel's entry in a repo's .mcp.json: the server that runs orrery-channel.mjs. */
function channelIn(dir) {
    try {
        const servers = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers ?? {}
        const found = Object.entries(servers).find(([, s]) => (s.args ?? []).some(a => String(a).includes('orrery-channel.mjs')))
        return found && {name: found[0], env: found[1].env ?? {}}
    } catch {
        return undefined
    }
}

/** The repo here as the launcher serves it: for each of its projects, its Orrery, the project, and its folder.
 * A value in .mcp.json counts only when it's plain, not `${…}`; a channel serving every project (`*`) needs
 * ORRERY_PROJECT to say which to start sessions for. */
function here() {
    const dir = process.cwd()
    const env = channelIn(dir)?.env ?? {}
    const plain = value => typeof value === 'string' && !value.includes('${') ? value : undefined
    const url = (process.env.ORRERY_URL ?? plain(env.ORRERY_URL) ?? 'http://localhost:9000').replace(/\/+$/, '')
    const listed = plain(env.ORRERY_PROJECTS)?.split(',').map(p => p.trim()).filter(p => p && p !== '*')
    const projects = process.env.ORRERY_PROJECT ? [process.env.ORRERY_PROJECT] : listed?.length ? listed : [plain(env.ORRERY_PROJECT) ?? basename(dir)]
    return projects.map(project => ({url, project, dir}))
}

/** tmux, 3.2 or newer (`new-session -e` hands each session its launch); says what's wrong when it isn't. */
function tmuxProblem() {
    let version
    try {
        version = tmux('-V')
    } catch {
        return 'tmux is needed to start sessions: install it (brew install tmux, apt install tmux) and run this again'
    }
    const [major, minor] = (version.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
    if (major !== undefined && (major < 3 || (major === 3 && minor < 2))) return `${version} is too old: starting sessions needs tmux 3.2 or newer`
    return null
}

const args = process.argv.slice(2)
const script = fileURLToPath(import.meta.url)
if (args.includes('--install') || args.includes('--uninstall')) {
    try {
        for (const entry of here()) {
            if (args.includes('--uninstall')) {
                const {config} = uninstall(entry, {script})
                console.log(`Took ${entry.project} (${entry.url}) off the launcher.`)
                console.log(config.projects.length ? `It still serves ${config.projects.map(p => p.project).join(', ')}.` : 'Nothing was left on it, so the service is removed.')
                continue
            }
            const problem = tmuxProblem()
            if (problem) throw new Error(problem)
            try {
                execFileSync('claude', ['--version'], {stdio: 'ignore'})
            } catch {
                throw new Error('claude isn\'t on your PATH: install Claude Code, then run this again from the same shell')
            }
            const found = await fetch(`${entry.url}/api/projects/${encodeURIComponent(entry.project)}/launches`).then(r => r.status).catch(() => 0)
            if (found === 404) throw new Error(`${entry.url} has no project ${entry.project}: set ORRERY_PROJECT (and ORRERY_URL) to the one to serve`)
            if (!found) log(`can't reach ${entry.url} now; the launcher keeps trying once it's installed`)
            if (!channelIn(entry.dir)) log(`no .mcp.json here registers orrery-channel.mjs, so its sessions won't hear Orrery: run this in the project's repo`)
            const {config, logs} = install(entry, {script})
            console.log(`The launcher now starts sessions for ${entry.project} (${entry.url}) in ${entry.dir}, from login on.`)
            console.log(`It serves ${config.projects.map(p => p.project).join(', ')}; the list is ${configFile()}.`)
            console.log(`Let Orrery start sessions on the project's Sessions tab, if it doesn't yet. Its log: ${logs}`)
        }
        if (!args.includes('--uninstall')) console.log(`If claude hasn't run in ${process.cwd()} before, run it there once to trust the folder.`)
        process.exit(0)
    } catch (error) {
        log(error.message)
        process.exit(1)
    }
}

const problem = tmuxProblem()
if (problem) {
    log(problem)
    process.exit(1)
}

/** The sessions this launcher started, by launch id: their tmux session and the timer that stops each, and
 * how to tell their project's Orrery they ended. */
const running = new Map()

/** Stops a session it started, and tells Orrery it ended by its launch (its own hook may not get the chance). */
async function stop(id, why) {
    const session = running.get(id)
    if (!session) return
    clearTimeout(session.timer)
    running.delete(id)
    try {
        tmux('kill-session', '-t', session.tmux)
        log(`stopped ${session.tmux}: ${why}`)
    } catch {
        // It had ended on its own.
    }
    await fetch(`${session.api}/launches/${id}/ended`, {method: 'POST'}).catch(() => {})
}

/** Gives a session it started a fresh context between pieces of work, as Orrery asks once it's idle: types
 * `/clear` into it. Its channel stays, and its hooks hand the new context what's left to do. */
async function clear(id) {
    const session = running.get(id)
    if (!session) return
    try {
        tmux('send-keys', '-t', session.tmux, '-l', '/clear')
        await new Promise(resolve => setTimeout(resolve, 300))
        tmux('send-keys', '-t', session.tmux, 'Enter')
        log(`cleared ${session.tmux}'s context: its work was done`)
    } catch {
        // It has ended.
    }
}

/** The tmux option a session keeps its stop time in, so a launcher that restarts can take it back. */
const STOPS_AT = '@orrery_stops_at'

/** Stops the session when `stops_at` comes (again, when the owner gives it longer). */
function stopAt(id, stopsAt) {
    const session = running.get(id)
    if (!session) return
    clearTimeout(session.timer)
    session.stops_at = stopsAt
    session.timer = setTimeout(() => stop(id, 'its time is up'), Math.max(0, Date.parse(stopsAt) - Date.now()))
    try {
        tmux('set-option', '-t', session.tmux, STOPS_AT, stopsAt)
    } catch {
        // It has ended; its timer finds it gone.
    }
}

/** The tmux session a launch on the project runs in, as Orrery names it. */
const tmuxName = (project, id) => `orrery-${project}-${id}`.replace(/[^\w-]/g, '-')

/** Takes back the project's sessions a launcher before this one started (it died without stopping them),
 * with their stop times; one without a stop time is stopped, as nothing would. */
function adopt(project, api) {
    let names = []
    try {
        names = tmux('list-sessions', '-F', '#{session_name}').split('\n')
    } catch {
        return // No tmux server: nothing is running.
    }
    const prefix = tmuxName(project, '')
    for (const name of names) {
        const id = name.startsWith(prefix) ? name.slice(prefix.length) : ''
        if (!/^[0-9a-f]{12}$/.test(id) || running.has(id)) continue
        running.set(id, {tmux: name, api})
        let stopsAt = ''
        try {
            stopsAt = tmux('show-options', '-v', '-t', name, STOPS_AT)
        } catch {
            // Started before stop times were kept.
        }
        if (Number.isNaN(Date.parse(stopsAt))) {
            stop(id, "it was started by a launcher before this one, and its time isn't known")
            continue
        }
        stopAt(id, stopsAt)
        log(`took back ${name}, running until ${new Date(stopsAt).toLocaleTimeString()}`)
    }
}

/** Tells the project's Orrery which of its sessions this launcher runs, so one that restarted knows them again. */
async function report(api) {
    const launches = [...running.entries()].filter(([, s]) => s.api === api && s.stops_at).map(([id, s]) => ({id, tmux: s.tmux, stops_at: s.stops_at}))
    await fetch(`${api}/launches/running`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({launches})})
        .catch(() => {})
}

/** Gets the new session past Claude Code's startup prompts: the channel flag's warning it accepts; a folder
 * not yet trusted it won't answer for the owner, so it stops the session and says so. */
async function getPast(id, dir) {
    const name = running.get(id)?.tmux
    for (let tries = 0; name && tries < 60; tries++) {
        await new Promise(resolve => setTimeout(resolve, 500))
        const screen = tmux('capture-pane', '-p', '-t', name)
        if (/trust (the files in )?this folder/i.test(screen)) return stop(id, `the folder isn't trusted yet: run claude in ${dir} once by hand and accept it`)
        if (screen.includes('Loading development channels') && screen.includes('I am using this for local development')) {
            tmux('send-keys', '-t', name, 'Enter')
            return
        }
    }
    log(`${name}: didn't see the channel's warning; if it's stuck on a prompt, answer it with: tmux attach -t ${name}`)
}

/** Serves one project: listens for its launches, and for the owner stopping or extending the sessions it started. */
function serve({url, project, dir}) {
    const api = `${url}/api/projects/${encodeURIComponent(project)}`
    adopt(project, api)

    /** Starts the launch's session, once this launcher has claimed it (another may have first). */
    async function start(launch) {
        const claim = await fetch(`${api}/launches/${launch.id}/claim`, {method: 'POST'}).then(r => r.json()).catch(() => ({claimed: false}))
        if (!claim.claimed) return
        const env = {ORRERY_URL: url, ORRERY_PROJECT: project, ORRERY_STARTED: launch.id, ORRERY_AFTER: String(launch.after)}
        tmux('new-session', '-d', '-s', launch.tmux, '-c', dir, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
            'claude', '--dangerously-load-development-channels', `server:${channelIn(dir)?.name ?? project}`, '--permission-mode', mode)
        running.set(launch.id, {tmux: launch.tmux, api})
        stopAt(launch.id, new Date(Date.now() + launch.minutes * 60_000).toISOString())
        log(`started ${launch.tmux} for ${launch.minutes} minutes; watch it with: tmux attach -t ${launch.tmux}`)
        getPast(launch.id, dir).catch(error => log(`${launch.tmux}: ${error.message}`))
    }

    return follow({
        url: () => `${api}/launches/stream`,
        onEvent: async ({event, data}) => {
            if (event === 'ready') {
                await report(api)
                const {starts} = JSON.parse(data)
                log(starts
                    ? `ready to start up to ${starts.limit} session(s) for ${project}, ${starts.minutes} minutes each`
                    : `connected, but ${project} doesn't let Orrery start sessions yet: turn it on from its Sessions tab`)
            } else if (event === 'launch') {
                await start(JSON.parse(data)).catch(error => log(`couldn't start a session for ${project}: ${error.message}`))
            } else if (event === 'stop') {
                await stop(JSON.parse(data).id, 'the owner stopped it')
            } else if (event === 'extend') {
                const {id, stops_at} = JSON.parse(data)
                stopAt(id, stops_at)
                if (running.has(id)) log(`${running.get(id).tmux} runs until ${new Date(stops_at).toLocaleTimeString()}`)
            } else if (event === 'clear') {
                await clear(JSON.parse(data).id)
            }
        },
        log: (...parts) => log(`${project}:`, ...parts),
    })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await Promise.all([...running.keys()].map(id => stop(id, 'the launcher stopped')))
        process.exit(0)
    })
}

// As the service, every project on the list; in a terminal, the repo's.
const projects = args.includes('--service') ? readConfig().projects : here()
if (!projects.length) {
    log(`no project is on ${configFile()}: run this with --install in a project's repo`)
    process.exit(0)
}
await Promise.all(projects.map(serve))
