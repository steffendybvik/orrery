#!/usr/bin/env node
// Orrery's launcher: starts Claude sessions for one project when Orrery asks, so work gets done without
// anyone opening a terminal. Run it on the host, in the project's repo (where .mcp.json registers the
// channel), with ORRERY_PROJECT (and ORRERY_URL) set:
//   ORRERY_PROJECT=shop node /path/to/orrery/channel/orrery-launcher.mjs
// Orrery asks only for a project the owner lets have sessions started (its settings), when the owner's
// signal finds nobody listening, within the project's limit and the Orrery's. Each session runs in a
// detached tmux session (`tmux attach -t <name>` to watch it), with the channel, in ORRERY_PERMISSION_MODE
// (`auto` by default, as nobody is there to answer a prompt), and is stopped after the project's minutes, or
// when the owner stops it from Orrery. With several launchers on a project, the first to claim a launch starts
// it. Stopping the launcher stops the sessions it started. It answers the warning Claude Code shows for the
// channel flag on every start (the channel is this repo's own); run the channel command once by hand in the
// repo first, to accept the folder's trust prompt, which it leaves to you.
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {basename} from 'node:path'
import {follow} from './sse.mjs'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
const project = process.env.ORRERY_PROJECT ?? basename(process.cwd())
const api = `${base}/api/projects/${encodeURIComponent(project)}`
const mode = process.env.ORRERY_PERMISSION_MODE || 'auto'
const log = (...parts) => console.error('[orrery launcher]', ...parts)
const tmux = (...args) => execFileSync('tmux', args, {encoding: 'utf8'}).trim()

// tmux 3.2 brought `new-session -e`, which hands each session its launch.
let version
try {
    version = tmux('-V')
} catch {
    log('tmux is needed to start sessions: install it (brew install tmux, apt install tmux) and run this again')
    process.exit(1)
}
const [major, minor] = (version.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number)
if (major !== undefined && (major < 3 || (major === 3 && minor < 2))) {
    log(`${version} is too old: starting sessions needs tmux 3.2 or newer`)
    process.exit(1)
}

/** The channel's name in the repo's .mcp.json: the server that runs orrery-channel.mjs, else the project's id. */
function channelName() {
    try {
        const servers = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers ?? {}
        return Object.entries(servers).find(([, s]) => (s.args ?? []).some(a => String(a).includes('orrery-channel.mjs')))?.[0] ?? project
    } catch {
        return project
    }
}

/** The sessions this launcher started, by launch id: their tmux session and the timer that stops each. */
const running = new Map()

/** Stops the session when `stopsAt` comes (again, when the owner gives it longer). */
function stopAt(id, stopsAt) {
    const session = running.get(id)
    if (!session) return
    clearTimeout(session.timer)
    session.timer = setTimeout(() => stop(id, 'its time is up'), Math.max(0, Date.parse(stopsAt) - Date.now()))
}

/** Starts the launch's session, once this launcher has claimed it (another may have first). */
async function start(launch) {
    const claim = await fetch(`${api}/launches/${launch.id}/claim`, {method: 'POST'}).then(r => r.json()).catch(() => ({claimed: false}))
    if (!claim.claimed) return
    const env = {ORRERY_URL: base, ORRERY_PROJECT: project, ORRERY_STARTED: launch.id, ORRERY_AFTER: String(launch.after)}
    tmux('new-session', '-d', '-s', launch.tmux, '-c', process.cwd(), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        'claude', '--dangerously-load-development-channels', `server:${channelName()}`, '--permission-mode', mode)
    running.set(launch.id, {tmux: launch.tmux})
    stopAt(launch.id, new Date(Date.now() + launch.minutes * 60_000).toISOString())
    log(`started ${launch.tmux} for ${launch.minutes} minutes; watch it with: tmux attach -t ${launch.tmux}`)
    getPast(launch.id).catch(error => log(`${launch.tmux}: ${error.message}`))
}

/** Gets the new session past Claude Code's startup prompts: the channel flag's warning it accepts; a folder
 * not yet trusted it won't answer for the owner, so it stops the session and says so. */
async function getPast(id) {
    const name = running.get(id)?.tmux
    for (let tries = 0; name && tries < 60; tries++) {
        await new Promise(resolve => setTimeout(resolve, 500))
        const screen = tmux('capture-pane', '-p', '-t', name)
        if (/trust (the files in )?this folder/i.test(screen)) return stop(id, `the folder isn't trusted yet: run claude in ${process.cwd()} once by hand and accept it`)
        if (screen.includes('Loading development channels') && screen.includes('I am using this for local development')) {
            tmux('send-keys', '-t', name, 'Enter')
            return
        }
    }
    log(`${name}: didn't see the channel's warning; if it's stuck on a prompt, answer it with: tmux attach -t ${name}`)
}

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
    await fetch(`${api}/launches/${id}/ended`, {method: 'POST'}).catch(() => {})
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await Promise.all([...running.keys()].map(id => stop(id, 'the launcher stopped')))
        process.exit(0)
    })
}

// Listens for launches, and for the owner stopping or extending the sessions it started.
await follow({
    url: () => `${api}/launches/stream`,
    onEvent: async ({event, data}) => {
        if (event === 'ready') {
            const {starts} = JSON.parse(data)
            log(starts
                ? `ready to start up to ${starts.limit} session(s) for ${project}, ${starts.minutes} minutes each`
                : `connected, but ${project} doesn't let Orrery start sessions yet: turn it on in its settings`)
        } else if (event === 'launch') {
            await start(JSON.parse(data)).catch(error => log(`couldn't start a session: ${error.message}`))
        } else if (event === 'stop') {
            await stop(JSON.parse(data).id, 'the owner stopped it')
        } else if (event === 'extend') {
            const {id, stopsAt} = JSON.parse(data)
            stopAt(id, stopsAt)
            if (running.has(id)) log(`${running.get(id).tmux} runs until ${new Date(stopsAt).toLocaleTimeString()}`)
        }
    },
    log,
})
