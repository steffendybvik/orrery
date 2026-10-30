// The launcher's part of Connect a repo (ORR-708): on the owner's click it opens this machine's own folder picker, and
// sets the folder they choose up. orrery never names a folder: the launcher keeps the one chosen and tells orrery only
// its last part, to show. Asked to write, it writes only to that folder.
import {execFile, execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {connectedIn, setUpRepo} from './repo-setup.mjs'
import {openTerminal} from './terminal.mjs'

const PROMPT = "Choose the repo to connect to orrery"
const MINUTES = 60_000

/** The machine's own folder picker, as `{command, args}`, or null where it has none: macOS's, or zenity or kdialog on a
 * Linux desktop. WSL has no way to reach Windows' with a Linux path, so that, like a server with no display, has the
 * Connect page's line instead. */
export function pickerFor({platform = process.platform, env = process.env, wsl = false, has = commandHere} = {}) {
    if (platform === 'darwin') return {command: 'osascript', args: ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt "${PROMPT}")`]}
    if (platform !== 'linux' || wsl || !(env.DISPLAY || env.WAYLAND_DISPLAY)) return null
    if (has('zenity')) return {command: 'zenity', args: ['--file-selection', '--directory', `--title=${PROMPT}`]}
    if (has('kdialog')) return {command: 'kdialog', args: ['--getexistingdirectory', homedir(), '--title', PROMPT]}
    return null
}

function commandHere(name) {
    try {
        return !!execFileSync('sh', ['-c', `command -v ${name}`], {encoding: 'utf8'}).trim()
    } catch {
        return false
    }
}

/** Waits for the owner to choose in `picker`: the folder, or null when they cancel it or leave it for ten minutes. All
 * these pickers say cancel by failing; anything else that goes wrong throws. */
export function choose(picker, run = execFile) {
    return new Promise((done, failed) => {
        run(picker.command, picker.args, {encoding: 'utf8', timeout: 10 * MINUTES}, (error, stdout, stderr) => {
            if (!error) return done(stdout.trim().replace(/(.)\/$/, '$1') || null)
            if (error.killed || error.code === 1) return /execution error/.test(stderr ?? '') && !/-128/.test(stderr) ? failed(new Error(stderr.trim().slice(0, 200))) : done(null)
            failed(error)
        })
    })
}

/** Why a folder won't do: the home folder and the root aren't a repo, and a hook there would run everywhere. */
export function folderProblem(dir, home = homedir()) {
    return resolve(dir) === resolve(home) || dirname(resolve(dir)) === resolve(dir) ? `${dir} isn't a repo: choose the repo's own folder` : null
}

/** A line of shell that opens Claude in `dir` with `server`'s channel. */
function claudeLine(dir, claude, server) {
    const quote = text => `'${text.replace(/'/g, "'\\''")}'`
    return `cd ${quote(dir)} && exec ${quote(claude)} --dangerously-load-development-channels server:${server}`
}

/** Puts the bootstrap on this machine if it isn't, as Connect's line does: the channel and hooks written run through it.
 * Only from this machine or https, as the bootstrap itself fetches. */
async function ensureBootstrap(url, {fetch, home}) {
    const file = join(home, '.orrery', 'bootstrap.mjs')
    if (existsSync(file)) return
    if (!/^https:|^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)) throw new Error(`${url} isn't on this machine or https, so orrery's bootstrap isn't fetched: run Connect's line once by hand`)
    const response = await fetch(`${url}/channel/bootstrap.mjs`, {redirect: 'error', signal: AbortSignal.timeout(10_000)})
    if (!response.ok) throw new Error(`orrery answered ${response.status} for its bootstrap`)
    mkdirSync(dirname(file), {recursive: true})
    writeFileSync(file, await response.text())
}

/** What the launcher does for one orrery's stream: `pick` opens the picker and tells orrery the folder's name, `write`
 * sets that folder up, puts it on the launcher's list and opens Claude there. `tell(id, body)` reports to orrery and
 * answers `{claimed}`; `serve(dir)` puts the repo on the list. */
export function connector({url, orreryId, picker, tell, serve, log, fetch = globalThis.fetch, home = homedir(), run = execFile, open = openIn, pick = choose}) {
    /** The folders the owner chose, by the request: orrery gets only its name, and can't name another. */
    const chosen = new Map()

    return {
        async pick({id}) {
            const {claimed} = await tell(id, {state: 'picking'})
            if (!claimed) return
            try {
                const dir = await pick(picker, run)
                if (!dir) return void await tell(id, {state: 'canceled'})
                const problem = folderProblem(dir, home)
                if (problem) return void await tell(id, {state: 'failed', message: problem})
                chosen.set(id, dir)
                await tell(id, {state: 'picked', folder: basename(dir), ...connectedIn(dir, {url, id: orreryId})})
            } catch (error) {
                log(`couldn't open a folder picker: ${error.message}`)
                await tell(id, {state: 'failed', message: `Couldn't open a folder picker: ${error.message}`})
            }
        },
        async write({id, projects, orrery, terminal}) {
            const dir = chosen.get(id)
            if (!dir) return
            chosen.delete(id)
            try {
                await ensureBootstrap(url, {fetch, home})
                const {server, written, unchanged, projects: listed} = setUpRepo(dir, {url, orrery, projects})
                serve(dir, listed)
                log(`connected ${dir}: wrote ${written.join(', ') || 'nothing new'}`)
                const opened = open({dir, server, terminal, log})
                await tell(id, {state: 'done', written, unchanged, opened})
            } catch (error) {
                log(`couldn't connect ${dir}: ${error.message}`)
                await tell(id, {state: 'failed', message: error.message})
            }
        },
    }
}

/** Opens a terminal with Claude in `dir` with the channel, where Claude Code asks once about the folder and the server.
 * Whether it could: the repo's set up either way. */
export function openIn({dir, server, terminal, log}) {
    try {
        const claude = execFileSync('sh', ['-c', 'command -v claude'], {encoding: 'utf8'}).trim() || 'claude'
        const {command, args, file} = openTerminal({app: terminal, argv: ['sh', '-c', claudeLine(dir, claude, server)], name: `claude-${basename(dir)}`.replace(/[^\w.-]/g, '_')})
        if (file) {
            mkdirSync(dirname(file.path), {recursive: true})
            writeFileSync(file.path, file.text)
        }
        execFileSync(command, args, {stdio: 'ignore'})
        return true
    } catch (error) {
        log(`couldn't open a terminal in ${dir}: ${error.message}`)
        return false
    }
}
