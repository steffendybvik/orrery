#!/usr/bin/env node
// orrery's launcher: starts Claude sessions for a project when orrery asks, so work gets done without
// anyone opening a terminal. Install it once in each project's repo (where .mcp.json registers the channel),
// as a background service that starts at login and serves every project installed:
//   node /path/to/orrery/channel/orrery-launcher.mjs --install      (--uninstall takes the repo's projects off;
//                                                                    --list shows which they'd be, changing nothing)
// or run it in a terminal for the repo's project alone, for as long as the terminal stays open:
//   ORRERY_PROJECT=shop node /path/to/orrery/channel/orrery-launcher.mjs
// The projects are ORRERY_PROJECT, else every one the channels in .mcp.json name (each channel's ORRERY_PROJECTS,
// or its ORRERY_PROJECT), else the folder's name, each on its channel's orrery (see repo-channels.mjs), and each
// project's sessions load the channel that serves it. A launch can name the projects its session hears (Start session
// with several of the repo's projects, or one alone), which it gets as ORRERY_HEAR; one naming none hears what the
// channel lists, every project with `*`. orrery asks only once the owner lets it start sessions (Starting sessions,
// on the Sessions page): when the owner's signal finds nobody listening, or the owner presses Start session, within
// the project's limit.
// Each session runs in a detached tmux session (`tmux attach -t <name>` to watch it, or Watch in orrery, which has
// this launcher open a terminal on it; the Sessions page's live view has it send the screen while it's open; the owner's
// Allow on a permission prompt has it press Enter on "Yes"), with the channel, in
// ORRERY_PERMISSION_MODE (`auto` by default, as nobody is there to answer a prompt; an untrusted schedule's session
// locked down instead, see `lockedDown`, and the owner's chat able only to read and answer, see `chatOnly`), and runs
// until orrery asks
// for it to be stopped: the owner stopping it, or, once it's idle with nothing open, its time being up or its having
// sat idle too long (when the project sets those). Between pieces of work orrery has it `/clear`ed, for a
// fresh context. With several launchers on a project, the first
// to claim a launch starts it. Stopping the launcher stops the sessions it started; one that dies instead (a
// crash, the service restarting it) takes its project's sessions back when it starts again, as each keeps its
// stop time (or `never`) and its launcher's pid in tmux, and tells orrery which it runs whenever it connects. A
// second launcher leaves alone the sessions of one that's still running, so stopping it can't stop them. As the
// service, once an orrery it serves runs other code and its checkout has been updated, it restarts itself on the new
// code when it has no session running. As the service it also follows its list while running (ORR-597): a project
// added there is served within a few seconds, and one taken off is let go, its sessions stopped, while the others' go on. It
// answers the warning Claude Code shows for the channel flag on every start (the channel is the repo's own); run
// the channel command once by hand in the repo first, to accept the folder's trust prompt, which it leaves to you.
import {execFileSync} from 'node:child_process'
import {mkdirSync, unwatchFile, watchFile, writeFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {adoptable, configFile, inWsl, install, listChanges, listIn, readConfig, serviceProblem, uninstall, wslLocalhost} from './launcher-service.mjs'
import {chatOnly, lockedDown} from './locked-down.mjs'
import {onYes} from './permission-prompt.mjs'
import {channelFor, projectsIn, servesEvery} from './repo-channels.mjs'
import {follow} from './sse.mjs'
import {openWatch} from './terminal.mjs'
import {CODE, VERSION, codeOnDisk, launcherMove, versionOnDisk} from './version.mjs'

const mode = process.env.ORRERY_PERMISSION_MODE || 'auto'
const log = (...parts) => console.error('[orrery launcher]', ...parts)
const tmux = (...args) => execFileSync('tmux', args, {encoding: 'utf8'}).trim()

/** The repo here as the launcher serves it: for each of its projects, its orrery, the project, and its folder. */
const here = () => projectsIn(process.cwd(), {project: process.env.ORRERY_PROJECT, url: process.env.ORRERY_URL})

/** Why `localhost` inside WSL may not be Windows' own (WSL2's default network is a NAT of its own). */
const WSL_LOCALHOST = "Inside WSL, localhost reaches an orrery on Windows when it runs in Docker Desktop (with WSL integration on), or with networkingMode=mirrored under [wsl2] in Windows' .wslconfig"

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
if (args.includes('--list')) {
    const served = readConfig().projects
    for (const {url, project, dir} of here()) {
        const elsewhere = served.find(p => p.url === url && p.project === project && p.dir !== dir)
        console.log(`${project} (${url}): sessions load ${channelFor(dir, url, project)?.name ?? 'no channel'}${elsewhere ? `; served from ${elsewhere.dir}, so --install leaves it there` : ''}`)
    }
    process.exit(0)
}
if (args.includes('--install') || args.includes('--uninstall')) {
    try {
        // Before tmux and claude are looked for: on Windows itself, neither is the problem.
        const unserved = serviceProblem()
        if (unserved) throw new Error(unserved)
        // Several channels can name a project served from its own repo (a monorepo's channel to the personal
        // orrery): it's left there unless ORRERY_PROJECT names it.
        const served = readConfig().projects
        const entries = here().filter(entry => {
            const elsewhere = served.find(p => p.url === entry.url && p.project === entry.project && p.dir !== entry.dir)
            if (elsewhere && !process.env.ORRERY_PROJECT) console.log(`Left ${entry.project} (${entry.url}) as it is, served from ${elsewhere.dir}; ORRERY_PROJECT=${entry.project} acts on it from here.`)
            return !elsewhere || process.env.ORRERY_PROJECT
        })
        if (!entries.length) process.exit(0)
        // All of the repo's projects at once. The running service follows the list; it restarts (stopping the sessions
        // it runs) only when its file changed, at most once.
        if (args.includes('--uninstall')) {
            const {config} = uninstall(entries, {script})
            console.log(`Took ${entries.map(e => `${e.project} (${e.url})`).join(', ')} off the launcher.`)
            console.log(config.projects.length ? `It still serves ${config.projects.map(p => p.project).join(', ')}.` : 'Nothing was left on it, so the service is removed.')
            process.exit(0)
        }
        const problem = tmuxProblem()
        if (problem) throw new Error(problem)
        try {
            execFileSync('claude', ['--version'], {stdio: 'ignore'})
        } catch {
            throw new Error('claude isn\'t on your PATH: install Claude Code, then run this again from the same shell')
        }
        for (const entry of entries) {
            const found = await fetch(`${entry.url}/api/projects/${encodeURIComponent(entry.project)}/launches`).then(r => r.status).catch(() => 0)
            if (found === 404) throw new Error(`${entry.url} has no project ${entry.project}: set ORRERY_PROJECT (and ORRERY_URL) to the one to serve`)
            if (!found) log(`can't reach ${entry.url} now; the launcher keeps trying once it's installed${inWsl() && wslLocalhost(entry.url) ? `. ${WSL_LOCALHOST}` : ''}`)
            if (!channelFor(entry.dir, entry.url, entry.project)) log(`no .mcp.json here registers orrery-channel.mjs, so ${entry.project}'s sessions won't hear orrery: run this in the project's repo`)
        }
        const {config, logs, restarted} = install(entries, {script})
        for (const {url, project, dir} of entries) {
            console.log(`The launcher now starts sessions for ${project} (${url}) in ${dir}, with ${channelFor(dir, url, project)?.name ?? 'no channel'}, from login on.`)
        }
        console.log(`It serves ${config.projects.map(p => p.project).join(', ')}; the list is ${configFile()}.${restarted ? '' : ' The running service picks the change up itself, so its sessions go on.'}`)
        console.log(`Let orrery start sessions on its Sessions page, if it doesn't yet. Its log: ${logs}`)
        console.log(`If claude hasn't run in ${process.cwd()} before, run it there once to trust the folder.`)
        if (inWsl()) console.log('Inside WSL it runs while the distro does: Windows starts the distro when you open it, and can stop it a while after its last window closes.')
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

/** The sessions this launcher started, by launch id: their tmux session, their stop time (none until stopped),
 * and how to tell their project's orrery they ended. */
const running = new Map()

/** Stops a session it started, and tells orrery it ended by its launch (its own hook may not get the chance). */
async function stop(id, why) {
    const session = running.get(id)
    if (!session) return
    running.delete(id)
    try {
        tmux('kill-session', '-t', session.tmux)
        log(`stopped ${session.tmux}: ${why}`)
    } catch {
        // It had ended on its own.
    }
    await fetch(`${session.api}/launches/${id}/ended`, {method: 'POST'}).catch(() => {})
    restartIfBehind()
}

/** The version each orrery it serves runs, as its stream said on connecting. */
const orreryVersions = new Map()
let toldBehind = ''
/** Its checkout moving on (ORR-434, ORR-470): as the service, with no session of its own running, it exits once the
 * checkout it runs from holds other code, a new version or a change within one, and launchd or systemd starts it again
 * on that code (it comes back when it exits with a failure). While an orrery it serves runs another version and the
 * checkout isn't updated, it says so once. */
function restartIfBehind() {
    const theirs = [...orreryVersions.values()]
    const disk = versionOnDisk()
    const move = launcherMove({theirs, mine: VERSION, code: CODE, now: codeOnDisk(), running: running.size, service: args.includes('--service')})
    const other = theirs.find(v => v !== VERSION)
    if (move === 'tell' && toldBehind !== other) {
        toldBehind = other
        log(`orrery runs ${other} and this launcher ${VERSION}: update the checkout it runs from (git pull), and it restarts itself`)
    } else if (move === 'restart') {
        log(`restarting on ${disk === VERSION ? `${disk}'s newer code` : disk}, the code now in its checkout`)
        process.exit(75)
    }
}

/** Opens a terminal window on this machine attached to a session it started, as the owner pressing Watch asks, in
 * the app the orrery's settings name. A session another launcher runs is that one's to open. */
function watch(id, app) {
    const session = running.get(id)
    if (!session) return
    try {
        const tmuxPath = execFileSync('sh', ['-c', 'command -v tmux'], {encoding: 'utf8'}).trim() || 'tmux'
        const {command, args, file} = openWatch({app, tmux: tmuxPath, name: session.tmux})
        if (file) {
            mkdirSync(dirname(file.path), {recursive: true})
            writeFileSync(file.path, file.text)
        }
        execFileSync(command, args, {stdio: 'ignore'})
        log(`opened ${app ?? 'a terminal'} on ${session.tmux}`)
    } catch (error) {
        log(`couldn't open a terminal on ${session.tmux} (${error.message}); attach by hand: tmux attach -t ${session.tmux}`)
    }
}

/** The sessions whose screens it's sending, so a second ask doesn't start a second loop. */
const viewing = new Set()

/** Sends the screen of a session it started (its tmux pane, as text) about once a second, as the owner viewing it
 * on the Sessions page asks, for as long as orrery says someone still is. Nothing goes into the session. */
async function view(id) {
    const session = running.get(id)
    if (!session || viewing.has(id)) return
    viewing.add(id)
    try {
        while (running.has(id)) {
            let screen
            try {
                screen = tmux('capture-pane', '-p', '-t', session.tmux)
            } catch {
                return // It has ended.
            }
            const {watching} = await fetch(`${session.api}/launches/${id}/screen`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({screen})})
                .then(response => response.ok ? response.json() : {watching: false}).catch(() => ({watching: false}))
            if (!watching) return
            await new Promise(resolve => setTimeout(resolve, 1000))
        }
    } finally {
        viewing.delete(id)
    }
}

/** Answers "Yes" once to the permission prompt a session it started is waiting at, as the owner pressing Allow asks
 * (ORR-489): only while its pane still shows one with the cursor on "Yes", so a late Allow can't answer another. */
function allow(id) {
    const session = running.get(id)
    if (!session) return
    try {
        if (!onYes(tmux('capture-pane', '-p', '-t', session.tmux))) return log(`${session.tmux} isn't at a permission prompt on "Yes" any more: left as it is`)
        tmux('send-keys', '-t', session.tmux, 'Enter')
        log(`allowed what ${session.tmux} asked, as the owner said`)
    } catch {
        // It has ended.
    }
}

/** Gives a session it started a fresh context between pieces of work, as orrery asks once it's idle: types
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

/** The tmux option a session keeps its stop time in (`never` for one that runs until stopped), so a launcher
 * that restarts can take it back. */
const STOPS_AT = '@orrery_stops_at'
const NEVER = 'never'
/** And the context the owner started it with (JSON), for an orrery that restarted to know it again. */
const CONTEXT = '@orrery_context'
/** The pid of the launcher that runs it, so another launcher leaves it alone while that one lives. */
const LAUNCHER = '@orrery_launcher'

/** Keeps the session's stop time (none: until stopped), for orrery to know again after a restart. orrery, not
 * this, stops it when the time comes, as only orrery knows whether it's done with its work. */
function keepStopTime(id, stopsAt) {
    const session = running.get(id)
    if (!session) return
    session.stops_at = stopsAt
    try {
        tmux('set-option', '-t', session.tmux, STOPS_AT, stopsAt ?? NEVER)
    } catch {
        // It has ended.
    }
}

/** And that it's an untrusted schedule's session, locked down, for orrery to keep holding it to that after a restart;
 * or the owner's chat, the same way. */
const UNTRUSTED = '@orrery_untrusted'
const CHAT = '@orrery_chat'

/** The tmux session a launch on the project runs in, as orrery names it. */
const tmuxName = (project, id) => `orrery-${project}-${id}`.replace(/[^\w-]/g, '-')

/** Takes back the project's sessions a launcher before this one started (it died without stopping them),
 * with their stop times; one that kept none (from before they were kept) is stopped, as nothing would. */
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
        let owner = ''
        try {
            owner = tmux('show-options', '-v', '-t', name, LAUNCHER)
        } catch {
            // Started before launchers kept their pid.
        }
        if (!adoptable(owner, process.pid)) {
            log(`left ${name} to the launcher running it (pid ${owner})`)
            continue
        }
        // Taken only if it's still the owner seen: tmux runs one command at a time, so of two launchers starting
        // together, one gets it and the other finds it taken.
        tmux('if-shell', '-F', '-t', name, `#{==:#{${LAUNCHER}},${owner}}`, `set-option -t ${name} ${LAUNCHER} ${process.pid}`)
        const now = tmux('show-options', '-v', '-t', name, LAUNCHER)
        if (now !== String(process.pid)) {
            log(`left ${name} to the launcher that took it first (pid ${now})`)
            continue
        }
        running.set(id, {tmux: name, api})
        let stopsAt = ''
        try {
            stopsAt = tmux('show-options', '-v', '-t', name, STOPS_AT)
        } catch {
            // Started before stop times were kept.
        }
        if (stopsAt !== NEVER && Number.isNaN(Date.parse(stopsAt))) {
            stop(id, "it was started by a launcher before this one, and its time isn't known")
            continue
        }
        keepStopTime(id, stopsAt === NEVER ? undefined : stopsAt)
        try {
            running.get(id).context = JSON.parse(tmux('show-options', '-v', '-t', name, CONTEXT))
        } catch {
            // Started with none.
        }
        try {
            if (tmux('show-options', '-v', '-t', name, UNTRUSTED) === 'yes') running.get(id).untrusted = true
        } catch {
            // An ordinary session.
        }
        try {
            if (tmux('show-options', '-v', '-t', name, CHAT) === 'yes') running.get(id).chat = true
        } catch {
            // Not a chat.
        }
        log(`took back ${name}, running ${stopsAt === NEVER ? 'until stopped' : `until ${new Date(stopsAt).toLocaleTimeString()}`}`)
    }
}

/** Tells the project's orrery which of its sessions this launcher runs, so one that restarted knows them again. */
async function report(api) {
    const launches = [...running.entries()].filter(([, s]) => s.api === api)
        .map(([id, s]) => ({id, tmux: s.tmux, ...s.stops_at ? {stops_at: s.stops_at} : {}, ...s.context ? {context: s.context} : {}, ...s.untrusted ? {untrusted: true} : {}, ...s.chat ? {chat: true} : {}}))
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

/** Where a project's launches are, on its orrery. */
const apiOf = ({url, project}) => `${url}/api/projects/${encodeURIComponent(project)}`

/** Serves one project: listens for its launches, and for the owner stopping or extending the sessions it started,
 * until `signal` lets it go. */
function serve({url, project, dir}, signal) {
    const api = apiOf({url, project})
    adopt(project, api)
    /** The token this connection's stream gave it (`ready`), which its claims send, so orrery knows they're a
     * launcher's (ORR-443). A new one comes with each reconnect. */
    let token = ''

    /** Starts the launch's session, once this launcher has claimed it (another may have first). */
    async function start(launch) {
        // It says it locks an untrusted launch down with no Bash, and starts a chat able only to read and answer: orrery
        // gives either only to a launcher that does.
        const claim = await fetch(`${api}/launches/${launch.id}/claim?untrusted=no-bash&chat=yes`, {method: 'POST', headers: {'Orrery-Launcher': token}}).then(r => r.json()).catch(() => ({claimed: false}))
        if (!claim.claimed) return
        // An untrusted one's channel says so on everything it sends, so orrery holds it to that even when it has
        // restarted and doesn't know the launch yet.
        const env = {ORRERY_URL: url, ORRERY_PROJECT: project, ORRERY_STARTED: launch.id, ORRERY_AFTER: String(launch.after), ...launch.hears?.length ? {ORRERY_HEAR: launch.hears.join(',')} : {}, ...launch.untrusted ? {ORRERY_UNTRUSTED: 'yes'} : {}, ...launch.chat ? {ORRERY_CHAT: 'yes'} : {}}
        const server = channelFor(dir, url, project)?.name ?? project
        tmux('new-session', '-d', '-s', launch.tmux, '-c', dir, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
            'claude', '--dangerously-load-development-channels', `server:${server}`, ...launch.untrusted ? lockedDown(dir, server) : launch.chat ? chatOnly(dir, server) : ['--permission-mode', mode])
        tmux('set-option', '-t', launch.tmux, LAUNCHER, String(process.pid))
        running.set(launch.id, {tmux: launch.tmux, api, context: launch.context, ...launch.untrusted ? {untrusted: true} : {}, ...launch.chat ? {chat: true} : {}})
        if (launch.context) tmux('set-option', '-t', launch.tmux, CONTEXT, JSON.stringify(launch.context))
        if (launch.untrusted) tmux('set-option', '-t', launch.tmux, UNTRUSTED, 'yes')
        if (launch.chat) tmux('set-option', '-t', launch.tmux, CHAT, 'yes')
        keepStopTime(launch.id, launch.minutes ? new Date(Date.now() + launch.minutes * 60_000).toISOString() : undefined)
        log(`started ${launch.tmux}${launch.untrusted ? ' locked down, for an untrusted schedule,' : launch.chat ? ' for a chat, able only to read and answer,' : ''} ${launch.minutes ? `for ${launch.minutes} minutes` : 'until stopped'}; watch it with: tmux attach -t ${launch.tmux}`)
        getPast(launch.id, dir).catch(error => log(`${launch.tmux}: ${error.message}`))
    }

    return follow({
        // The folder it serves from, so orrery knows which projects share one and can share a session, and whether its
        // channel serves every project, so a session started here hearing no one project hears them all.
        url: () => `${api}/launches/stream?dir=${encodeURIComponent(dir)}${servesEvery(dir, url, project) ? '&every=1' : ''}&version=${encodeURIComponent(VERSION)}`,
        onEvent: async ({event, data}) => {
            if (event === 'ready') {
                const {starts, version, token: given} = JSON.parse(data)
                token = given ?? ''
                await report(api)
                if (version) orreryVersions.set(url, version)
                restartIfBehind()
                log(starts
                    ? `ready to start up to ${starts.limit} session(s) for ${project}, ${starts.minutes ? `${starts.minutes} minutes each` : 'each until stopped'}`
                    : "connected, but orrery doesn't start sessions yet: turn it on under Starting sessions, on its Sessions page")
            } else if (event === 'launch') {
                await start(JSON.parse(data)).catch(error => log(`couldn't start a session for ${project}: ${error.message}`))
            } else if (event === 'stop') {
                await stop(JSON.parse(data).id, 'orrery asked for it to stop')
            } else if (event === 'extend') {
                const {id, stops_at} = JSON.parse(data)
                keepStopTime(id, stops_at)
                if (running.has(id)) log(`${running.get(id).tmux} runs until ${new Date(stops_at).toLocaleTimeString()}`)
            } else if (event === 'clear') {
                await clear(JSON.parse(data).id)
            } else if (event === 'watch') {
                const {id, terminal} = JSON.parse(data)
                watch(id, terminal)
            } else if (event === 'allow') {
                allow(JSON.parse(data).id)
            } else if (event === 'view') {
                // Not awaited: it sends for as long as the owner views it, and the stream goes on meanwhile.
                view(JSON.parse(data).id).catch(error => log(`couldn't send a screen: ${error.message}`))
            }
        },
        log: (...parts) => log(`${project}:`, ...parts),
        signal,
    })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        unwatchFile(configFile())
        await Promise.all([...running.keys()].map(id => stop(id, 'the launcher stopped')))
        process.exit(0)
    })
}

/** The projects it serves, by orrery and project: each one's entry, and what lets it go. */
const serving = new Map()
const servingKey = ({url, project}) => `${url} ${project}`

function begin(entry) {
    const abort = new AbortController()
    serving.set(servingKey(entry), {entry, abort})
    serve(entry, abort.signal).catch(error => log(`${entry.project}: ${error.message}`))
}

/** Lets go of a project taken off the list: stops following it, and stops the sessions it started for it, as taking it
 * off with --uninstall means. One that only moved to another repo keeps its sessions, served from there next. */
async function letGo(entry, {moved}) {
    serving.get(servingKey(entry))?.abort.abort()
    serving.delete(servingKey(entry))
    if (![...serving.values()].some(s => s.entry.url === entry.url)) orreryVersions.delete(entry.url)
    if (moved) return
    const api = apiOf(entry)
    await Promise.all([...running].filter(([, s]) => s.api === api).map(([id]) => stop(id, `${entry.project} was taken off the launcher`)))
}

/** Brings what it serves in line with the list, one change at a time. */
let following = Promise.resolve()
function follows() {
    following = following.then(async () => {
        const list = listIn()
        if (!list) return log(`${configFile()} can't be read as a list; it serves what it did until it can`)
        const {added, removed} = listChanges([...serving.values()].map(s => s.entry), list.projects)
        for (const entry of removed) {
            const moved = added.some(a => servingKey(a) === servingKey(entry))
            await letGo(entry, {moved})
            log(moved ? `${entry.project} (${entry.url}) moved to ${added.find(a => servingKey(a) === servingKey(entry)).dir}` : `let go of ${entry.project} (${entry.url}): it's off the list`)
        }
        for (const entry of added) {
            if (!removed.some(r => servingKey(r) === servingKey(entry))) log(`now serving ${entry.project} (${entry.url}) in ${entry.dir}: it's on the list`)
            begin(entry)
        }
    }).catch(error => log(`couldn't follow ${configFile()}: ${error.message}`))
}

// As the service, every project on the list, following it as it changes; in a terminal, the repo's.
const service = args.includes('--service')
const projects = service ? readConfig().projects : here()
if (!projects.length) {
    log(`no project is on ${configFile()}: run this with --install in a project's repo`)
    process.exit(0)
}
for (const entry of projects) begin(entry)
if (service) watchFile(configFile(), {interval: 2000}, follows)
