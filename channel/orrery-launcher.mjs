#!/usr/bin/env node
// Orrery's launcher: starts Claude sessions for one project when Orrery asks, so work gets done without
// anyone opening a terminal. Run it on the host, in the project's repo (where .mcp.json registers the
// channel), with ORRERY_PROJECT (and ORRERY_URL) set:
//   ORRERY_PROJECT=shop node /path/to/orrery/channel/orrery-launcher.mjs
// Orrery asks only for a project the owner lets have sessions started (its settings), when the owner's
// signal finds nobody listening, within the project's limit and the Orrery's. Each session runs in a
// detached tmux session (`tmux attach -t <name>` to watch it), with the channel, in ORRERY_PERMISSION_MODE
// (`auto` by default, as nobody is there to answer a prompt), and is stopped after the project's minutes.
// Stopping the launcher stops the sessions it started. It answers the warning Claude Code shows for the
// channel flag on every start (the channel is this repo's own); run the channel command once by hand in the
// repo first, to accept the folder's trust prompt, which it leaves to you.
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import {basename} from 'node:path'

const base = (process.env.ORRERY_URL ?? 'http://localhost:9000').replace(/\/+$/, '')
const project = process.env.ORRERY_PROJECT ?? basename(process.cwd())
const api = `${base}/api/projects/${encodeURIComponent(project)}`
const mode = process.env.ORRERY_PERMISSION_MODE || 'auto'
const log = (...parts) => console.error('[orrery launcher]', ...parts)
const tmux = (...args) => execFileSync('tmux', args, {encoding: 'utf8'}).trim()

try {
    tmux('-V')
} catch {
    log('tmux is needed to start sessions: install it (brew install tmux, apt install tmux) and run this again')
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

/** The sessions this launcher started, by tmux name, with the timer that stops each. */
const running = new Map()

function start(launch) {
    const name = `orrery-${project}-${launch.id}`.replace(/[^\w-]/g, '-')
    const env = {ORRERY_URL: base, ORRERY_PROJECT: project, ORRERY_STARTED: launch.id, ORRERY_AFTER: String(launch.after)}
    tmux('new-session', '-d', '-s', name, '-c', process.cwd(), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        'claude', '--dangerously-load-development-channels', `server:${channelName()}`, '--permission-mode', mode)
    running.set(name, setTimeout(() => stop(name, `its ${launch.minutes} minutes are up`), launch.minutes * 60_000))
    log(`started ${name} for ${launch.minutes} minutes; watch it with: tmux attach -t ${name}`)
    getPast(name).catch(error => log(`${name}: ${error.message}`))
}

/** Gets the new session past Claude Code's startup prompts: the channel flag's warning it accepts; a folder
 * not yet trusted it won't answer for the owner, so it stops the session and says so. */
async function getPast(name) {
    for (let tries = 0; tries < 60; tries++) {
        await new Promise(resolve => setTimeout(resolve, 500))
        const screen = tmux('capture-pane', '-p', '-t', name)
        if (/trust (the files in )?this folder/i.test(screen)) return stop(name, `the folder isn't trusted yet: run claude in ${process.cwd()} once by hand and accept it`)
        if (screen.includes('Loading development channels') && screen.includes('I am using this for local development')) {
            tmux('send-keys', '-t', name, 'Enter')
            return
        }
    }
    log(`${name}: didn't see the channel's warning; if it's stuck on a prompt, answer it with: tmux attach -t ${name}`)
}

/** Stops a session it started, and tells Orrery it ended (its own hook may not get the chance). */
async function stop(name, why) {
    clearTimeout(running.get(name))
    running.delete(name)
    let pid
    try {
        pid = Number(tmux('display-message', '-p', '-t', name, '#{pane_pid}')) || undefined
        tmux('kill-session', '-t', name)
        log(`stopped ${name}: ${why}`)
    } catch {
        return // It ended on its own.
    }
    if (pid) {
        await fetch(`${base}/api/sessions`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({pid, project, event: 'SessionEnd'}),
        }).catch(() => {})
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await Promise.all([...running.keys()].map(name => stop(name, 'the launcher stopped')))
        process.exit(0)
    })
}

// Listens for launches, and after a drop connects again.
for (let wait = 1000; ; wait = Math.min(wait * 2, 30_000)) {
    try {
        const response = await fetch(`${api}/launches/stream`, {headers: {Accept: 'text/event-stream'}})
        if (!response.ok || !response.body) throw new Error(`${response.status} ${response.statusText}`)
        wait = 1000
        let buffer = ''
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
            buffer += chunk
            let end
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const block = buffer.slice(0, end)
                buffer = buffer.slice(end + 2)
                const field = name => block.split('\n').filter(l => l.startsWith(`${name}:`)).map(l => l.slice(name.length + 1).trimStart()).join('\n')
                const data = field('data')
                if (field('event') === 'ready') {
                    const {starts} = JSON.parse(data)
                    log(starts
                        ? `ready to start up to ${starts.limit} session(s) for ${project}, ${starts.minutes} minutes each`
                        : `connected, but ${project} doesn't let Orrery start sessions yet: turn it on in its settings`)
                } else if (field('event') === 'launch') {
                    try {
                        start(JSON.parse(data))
                    } catch (error) {
                        log(`couldn't start a session: ${error.message}`)
                    }
                }
            }
        }
        log('the stream ended; reconnecting')
    } catch (error) {
        log(`can't reach Orrery (${error.message}); trying again in ${wait / 1000}s`)
    }
    await new Promise(resolve => setTimeout(resolve, wait))
}
