// How the launcher opens a terminal window attached to one of its sessions, when the owner presses Watch: the app
// is the orrery's setting (Terminal, iTerm2, Warp or Ghostty, on macOS); elsewhere the system's own terminal.
// Each is a command to run and, for Warp, a tab config to write first, as Warp runs a command only from one.
import {homedir} from 'node:os'
import {join} from 'node:path'

/** A string as AppleScript writes it. */
const appleString = text => `"${text.replace(/[\\"]/g, '\\$&')}"`

/** What opens `app` attached to the tmux session `name`, with `tmux` the tmux to run (its full path, as an app
 * opened outside a shell may not have the launcher's PATH): `{command, args, file?}`, `file` being `{path, text}`
 * to write before running it. */
export function openWatch({app, tmux, name, platform = process.platform, home = homedir()}) {
    const attach = [tmux, 'attach', '-t', name]
    const line = attach.map(part => `'${part.replace(/'/g, "'\\''")}'`).join(' ')
    if (platform !== 'darwin') return {command: 'x-terminal-emulator', args: ['-e', ...attach]}
    if (app === 'iterm') return {command: 'osascript', args: ['-e', `tell application "iTerm" to create window with default profile command ${appleString(line)}`]}
    if (app === 'ghostty') return {command: 'open', args: ['-na', 'Ghostty', '--args', '-e', ...attach]}
    if (app === 'warp') {
        const text = [`name = "Watch ${name}"`, `title = "${name}"`, '', '[[panes]]', 'id = "watch"', 'type = "terminal"', `commands = [${JSON.stringify(line)}]`, ''].join('\n')
        return {command: 'open', args: ['warp://tab_config/orrery_watch?new_window=true'], file: {path: join(home, '.warp', 'tab_configs', 'orrery_watch.toml'), text}}
    }
    return {command: 'osascript', args: ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${appleString(line)}`, '-e', 'end tell']}
}
