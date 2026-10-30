// The launcher as a background service, so nobody keeps a terminal open for it: `--install`, run once in a
// project's repo, adds the project to the launcher's list (~/.config/orrery/launcher.json) and registers one
// service for every project on it, with launchd on macOS or systemd on Linux (on Windows, inside WSL with systemd
// on: ORR-576). It starts at login, comes back if it dies, and starts each project's sessions in its repo. Run
// anywhere else, `--install` registers the service with nothing on the list yet (ORR-598). Either way it turns repo
// pick-up on (`pickUp`, off with `--no-pick-up`), for a repo's channel to add the repo's projects as it connects (ORR-599).
// `--uninstall` in a repo takes its projects off the list and keeps the repo off it (`skip`), so pick-up doesn't
// add it back; with pick-up off it removes the service with the last project. Anywhere else it removes the service,
// keeping the list. The running service follows the list as it changes (ORR-597), so neither restarts it, and the
// sessions it runs go on, unless its file changed.
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'

export const LABEL = 'orrery.launcher'
export const configFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orrery', 'launcher.json')

/** Whether this is Linux inside WSL on Windows: WSL's own variables say so, or its kernel's name. */
export function inWsl({env = process.env, kernel = () => readFileSync('/proc/version', 'utf8')} = {}) {
    if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true
    try {
        return /microsoft/i.test(kernel())
    } catch {
        return false
    }
}

/** Whether `url` is this machine's own address, which inside WSL is the distro's, not always Windows'. */
export const wslLocalhost = url => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url)

/** What stops the service being installed here, said with what to do; none when nothing does. Windows runs it inside
 * WSL, which needs systemd turned on, as plain Linux without systemd can't run it as a service either. */
export function serviceProblem({platform = process.platform, wsl = platform === 'linux' && inWsl(), systemd = existsSync('/run/systemd/system')} = {}) {
    if (platform === 'darwin') return null
    if (platform === 'win32') return 'on Windows the launcher runs inside WSL: open your WSL distro, get the repo there, and run this again from it'
    if (platform !== 'linux') return `the launcher installs as a service on macOS and Linux only, not ${platform}; run it in a terminal instead`
    if (systemd) return null
    if (wsl) return 'systemd is off in this WSL distro: add "[boot]" and "systemd=true" to /etc/wsl.conf, run "wsl --shutdown" in Windows, open the distro again and run this again'
    return "systemd isn't running here, so the launcher can't install as a service; run it in a terminal instead"
}

/** The launcher's list: `{projects: [{url, project, dir}], pickUp, skip}`, empty when there's none yet. `pickUp`:
 * whether a repo's channel adds the repo as it connects; `skip`: the repos `--uninstall` took off, which it doesn't. */
export function readConfig(file = configFile()) {
    return listIn(file) ?? empty()
}

const empty = () => ({projects: [], pickUp: false, skip: []})

/** The list, empty when its file is missing, or null when the file can't be read as one (broken, or caught half
 * written), which the running service skips rather than taking every project off. */
export function listIn(file = configFile()) {
    let text
    try {
        text = readFileSync(file, 'utf8')
    } catch {
        return empty()
    }
    try {
        const config = JSON.parse(text)
        return {
            projects: Array.isArray(config.projects) ? config.projects : [],
            pickUp: config.pickUp === true,
            skip: Array.isArray(config.skip) ? config.skip.filter(dir => typeof dir === 'string') : [],
        }
    } catch {
        return null
    }
}

/** Writes the list whole, by a rename, so the running service following it never reads it half written. */
function writeList(config, file = configFile()) {
    mkdirSync(dirname(file), {recursive: true})
    const next = `${file}.${process.pid}`
    writeFileSync(next, `${JSON.stringify(config, null, 2)}\n`)
    renameSync(next, file)
}

const same = (a, b) => a.url === b.url && a.project === b.project

/** The list with the project on it once, in its repo now if it moved. */
export function withProject(config, entry) {
    return {...config, projects: [...config.projects.filter(p => !same(p, entry)), entry]}
}

/** The list without the project. */
export function withoutProject(config, entry) {
    return {...config, projects: config.projects.filter(p => !same(p, entry))}
}

/** Where the project `entry` is served from another repo than its own, if it is (a monorepo's channel to the personal
 * orrery): `--install` leaves it there unless ORRERY_PROJECT names it, and pick-up always does. */
export const servedElsewhere = (projects, entry) => projects.find(p => same(p, entry) && p.dir !== entry.dir)

/** Pick-up (ORR-599): a repo's channel, as it connects, puts the repo's projects (`entries`, each in `dir`) on the list
 * the way `--install` there would, when pick-up is on, the repo isn't kept off (`--uninstall` there) and a project
 * isn't on the list already, from this repo or another. It writes the list alone, which the running service follows.
 * Each is marked with when it was picked up. Says which it put on. */
export function pickUp(entries, dir, {file = configFile(), now = new Date()} = {}) {
    const config = listIn(file)
    if (!config?.pickUp || config.skip.includes(dir)) return []
    const added = entries.filter(entry => entry.dir === dir && !config.projects.some(p => same(p, entry)))
        .map(entry => ({...entry, picked_at: now.toISOString()}))
    if (added.length) writeList(added.reduce(withProject, config), file)
    return added
}

/** The list with the repo at `dir` kept off it (`--uninstall` there) or not (`--install`), for pick-up. */
export function skipping(config, dir, skip) {
    const others = config.skip.filter(d => d !== dir)
    return {...config, skip: skip ? [...others, dir] : others}
}

/** What the running service has to do when its list goes from `before` to `after`: serve the projects `added`, and let
 * go of those `removed`. A project that moved to another repo is both, so it's served from the new one. */
export function listChanges(before, after) {
    const kept = (entry, list) => list.some(p => same(p, entry) && p.dir === entry.dir)
    return {added: after.filter(p => !kept(p, before)), removed: before.filter(p => !kept(p, after))}
}

/** Set in the service's environment by a launcher that follows its list while running (ORR-597). A service file
 * without it ran one that read the list only at start, so installing over it restarts it once, onto the code that
 * follows. */
export const RELOADS = 'ORRERY_LAUNCHER_RELOADS'

const xml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** launchd's file for the service: node running the launcher for every project on the list, with the PATH
 * it was installed from (launchd's own has no Homebrew, so no tmux or claude), logging to `log`. It comes
 * back when it dies, not when it exits on its own (with nothing to start). */
export function plist({node, script, path, log}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string>${[script].flat().map(part => `<string>${xml(part)}</string>`).join('')}<string>--service</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string><key>${RELOADS}</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

/** What keeps a unit's sessions going when its launcher restarts: left to itself, systemd kills all that's in the
 * service's cgroup as it exits, the tmux server its sessions run in among them. */
const KEEP_SESSIONS = 'KillMode=process'
/** A unit installed before that, with it added where `systemdUnit` puts it, so installing again doesn't restart it. */
export const keepingSessions = unit => unit.includes(KEEP_SESSIONS) ? unit : unit.replace('[Service]\n', `[Service]\n${KEEP_SESSIONS}\n`)

/** systemd's user unit for the service, the same way; it logs to the journal. Inside WSL, `distro` is the one it was
 * installed from, which Watch opens Windows Terminal on (the service doesn't get WSL's own variables). */
export function systemdUnit({node, script, path, distro}) {
    const quote = text => `"${String(text).replace(/(["\\])/g, '\\$1')}"`
    return `[Unit]
Description=orrery launcher: starts Claude sessions for orrery

[Service]
${KEEP_SESSIONS}
ExecStart=${quote(node)} ${[script].flat().map(quote).join(' ')} --service
Environment=${quote(`${RELOADS}=1`)}
Environment=${quote(`PATH=${path}`)}
${distro ? `Environment=${quote(`WSL_DISTRO_NAME=${distro}`)}\n` : ''}Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
}

const run = (command, ...args) => execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()

/** Where the service's file goes, and how it's (re)started and removed, on this machine. */
function platform() {
    const problem = serviceProblem()
    if (problem) throw new Error(problem)
    const uid = process.getuid?.()
    if (process.platform === 'darwin') {
        const file = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
        const log = join(homedir(), 'Library', 'Logs', 'orrery-launcher.log')
        return {
            file, logs: log, render: opts => plist({...opts, log}),
            start: () => {
                try {
                    run('launchctl', 'bootout', `gui/${uid}/${LABEL}`)
                } catch {
                    // It wasn't loaded.
                }
                // bootout returns before the old one has gone, and bootstrap fails (5: Input/output error) until it
                // has: a few tries, half a second apart.
                for (let tries = 1; ; tries++) {
                    try {
                        return run('launchctl', 'bootstrap', `gui/${uid}`, file)
                    } catch (error) {
                        if (tries === 10) throw error
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
                    }
                }
            },
            stop: () => run('launchctl', 'bootout', `gui/${uid}/${LABEL}`),
            running: () => {
                try {
                    // Loaded isn't enough: one that exited on its own stays loaded, and wouldn't pick the list up.
                    return /^\s*state = running$/m.test(run('launchctl', 'print', `gui/${uid}/${LABEL}`))
                } catch {
                    return false
                }
            },
        }
    }
    // Linux, WSL's included: systemd.
    const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'orrery-launcher.service')
    return {
        file, logs: 'journalctl --user -u orrery-launcher -f', render: opts => systemdUnit({...opts, distro: process.env.WSL_DISTRO_NAME}),
        start: () => {
            run('systemctl', '--user', 'daemon-reload')
            run('systemctl', '--user', 'enable', 'orrery-launcher')
            run('systemctl', '--user', 'restart', 'orrery-launcher')
        },
        stop: () => run('systemctl', '--user', 'disable', '--now', 'orrery-launcher'),
        running: () => {
            try {
                return run('systemctl', '--user', 'is-active', 'orrery-launcher') === 'active'
            } catch {
                return false
            }
        },
    }
}

/** Writes the list, then the service's file, (re)starting the service only when that file changed or it isn't
 * running: a running one picks the new list up itself. Says whether it restarted. */
function apply(where, config, opts) {
    writeList(config)
    const text = where.render(opts)
    let was = ''
    try {
        was = readFileSync(where.file, 'utf8')
    } catch {
        // Not installed yet.
    }
    if (was === text && where.running()) return false
    mkdirSync(dirname(where.file), {recursive: true})
    writeFileSync(where.file, text)
    where.start()
    return true
}

/** Adds the projects of the repo at `dir` to the list (none, and no `dir`, to install the service alone), sets
 * pick-up, and starts the service if it isn't running on the same file. A restart stops the sessions it was running. */
export function install(entries, {node = process.execPath, script, path = process.env.PATH ?? '', dir, pickUp = true}) {
    const where = platform()
    const listed = {...entries.reduce(withProject, readConfig()), pickUp}
    const config = dir ? skipping(listed, dir, false) : listed
    const restarted = apply(where, config, {node, script, path})
    return {config, file: where.file, logs: where.logs, restarted}
}

/** Takes the projects of the repo at `dir` off the list and keeps the repo off it, which the running service follows.
 * With pick-up off, the last project takes the service with it; with it on, the service stays to be handed repos. */
export function uninstall(entries, {node = process.execPath, script, path = process.env.PATH ?? '', dir}) {
    const where = platform()
    const config = skipping(entries.reduce(withoutProject, readConfig()), dir, true)
    if (config.projects.length || config.pickUp) {
        apply(where, config, {node, script, path})
    } else {
        removeService(where, config)
    }
    return {config, file: where.file}
}

/** Whether the sessions outlive the service restarting itself (ORR-686). On a Mac they do, as launchd kills only its
 * job's process group and the tmux server has its own. systemd needs telling, so an older unit is brought up to date
 * here, which takes effect with no restart. */
export function restartKeepsSessions() {
    if (process.platform === 'darwin') return true
    try {
        const {file} = platform()
        const unit = readFileSync(file, 'utf8')
        const kept = keepingSessions(unit)
        if (kept !== unit) {
            writeFileSync(file, kept)
            run('systemctl', '--user', 'daemon-reload')
        }
        return kept.includes(KEEP_SESSIONS)
    } catch {
        return false
    }
}

/** Stops the service and removes its file, whatever is on the list, which stays for the next `--install`. Pick-up goes
 * off with it, so no channel puts a repo on a list nothing serves. */
export function removeService(where = platform(), config = readConfig()) {
    writeList({...config, pickUp: false})
    try {
        where.stop()
    } catch {
        // It wasn't running.
    }
    rmSync(where.file, {force: true})
    return {file: where.file}
}

/** Whether the process `pid` is a launcher still running. Once a launcher dies the system can hand its pid to
 * another program, which doesn't count: its sessions would otherwise be left to nobody. */
export function launcherAlive(pid) {
    try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {encoding: 'utf8'}).includes('orrery-launcher')
    } catch {
        return false // No such process.
    }
}

/** Whether a launcher (`self`, its pid) may take over a session whose launcher was `owner` (the pid it keeps in
 * tmux, `''` when it kept none): only when that launcher is gone, so a second launcher leaves the first one's
 * sessions alone. One with no owner kept was started before owners were, and is taken as before. */
export function adoptable(owner, self, alive = launcherAlive) {
    const pid = Number(owner)
    return !owner || !Number.isInteger(pid) || pid <= 0 || pid === self || !alive(pid)
}
