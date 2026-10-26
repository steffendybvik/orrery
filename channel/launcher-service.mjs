// The launcher as a background service, so nobody keeps a terminal open for it: `--install`, run once in a
// project's repo, adds the project to the launcher's list (~/.config/orrery/launcher.json) and registers one
// service for every project on it, with launchd on macOS or systemd on Linux. It starts at login, comes back
// if it dies, and starts each project's sessions in its repo. `--uninstall` takes the repo's project off the
// list, and the service with the last one.
import {execFileSync} from 'node:child_process'
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'

export const LABEL = 'orrery.launcher'
export const configFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orrery', 'launcher.json')

/** The launcher's list: `{projects: [{url, project, dir}]}`, empty when there's none yet. */
export function readConfig(file = configFile()) {
    try {
        const config = JSON.parse(readFileSync(file, 'utf8'))
        return {projects: Array.isArray(config.projects) ? config.projects : []}
    } catch {
        return {projects: []}
    }
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
  <array><string>${xml(node)}</string><string>${xml(script)}</string><string>--service</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}

/** systemd's user unit for the service, the same way; it logs to the journal. */
export function systemdUnit({node, script, path}) {
    const quote = text => `"${String(text).replace(/(["\\])/g, '\\$1')}"`
    return `[Unit]
Description=Orrery launcher: starts Claude sessions for Orrery

[Service]
ExecStart=${quote(node)} ${quote(script)} --service
Environment=${quote(`PATH=${path}`)}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
}

const run = (command, ...args) => execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()

/** Where the service's file goes, and how it's (re)started and removed, on this machine. */
function platform() {
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
        }
    }
    if (process.platform === 'linux') {
        const file = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', 'orrery-launcher.service')
        return {
            file, logs: 'journalctl --user -u orrery-launcher -f', render: systemdUnit,
            start: () => {
                run('systemctl', '--user', 'daemon-reload')
                run('systemctl', '--user', 'enable', 'orrery-launcher')
                run('systemctl', '--user', 'restart', 'orrery-launcher')
            },
            stop: () => run('systemctl', '--user', 'disable', '--now', 'orrery-launcher'),
        }
    }
    throw new Error(`the launcher installs as a service on macOS and Linux only, not ${process.platform}; run it in a terminal instead`)
}

/** Adds the project to the list and (re)starts the service with it. Restarting stops the sessions it was running. */
export function install(entries, {node = process.execPath, script, path = process.env.PATH ?? ''}) {
    const where = platform()
    const config = entries.reduce(withProject, readConfig())
    mkdirSync(dirname(configFile()), {recursive: true})
    writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`)
    mkdirSync(dirname(where.file), {recursive: true})
    writeFileSync(where.file, where.render({node, script, path}))
    where.start()
    return {config, file: where.file, logs: where.logs}
}

/** Takes the project off the list, restarting the service without it, or removing it with the last one. */
export function uninstall(entries, {node = process.execPath, script, path = process.env.PATH ?? ''}) {
    const where = platform()
    const config = entries.reduce(withoutProject, readConfig())
    mkdirSync(dirname(configFile()), {recursive: true})
    writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`)
    if (config.projects.length) {
        writeFileSync(where.file, where.render({node, script, path}))
        where.start()
    } else {
        try {
            where.stop()
        } catch {
            // It wasn't running.
        }
        rmSync(where.file, {force: true})
    }
    return {config, file: where.file}
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
