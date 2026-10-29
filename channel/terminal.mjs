// How the launcher opens a terminal window attached to one of its sessions, when the owner presses Watch: the app
// is the orrery's setting (Terminal, iTerm2, Warp or Ghostty, on macOS); elsewhere the system's own terminal.
// Each is a command to run and, for Warp, a tab config to write first, as Warp runs a command only from one.
import {homedir} from 'node:os'
import {join} from 'node:path'

/** A string as AppleScript writes it. */
const appleString = text => `"${text.replace(/[\\"]/g, '\\$&')}"`

/** AppleScript that has `app` run the attach in one window. Started by this, Terminal and iTerm2 open a window of
 * their own first, so when the app wasn't running the attach goes into that window (waited for, up to 5s) instead of
 * a second one (ORR-564); when it was, into a new window. */
function appleWatch(app, here, fresh) {
    return [
        `set wasRunning to application "${app}" is running`,
        `tell application "${app}"`,
        'if not wasRunning then',
        'repeat 50 times',
        'if (count windows) > 0 then exit repeat',
        'delay 0.1',
        'end repeat',
        'end if',
        'if not wasRunning and (count windows) > 0 then',
        here,
        'else',
        fresh,
        'end if',
        'activate',
        'end tell',
    ].flatMap(part => ['-e', part])
}

/** What opens `app` attached to the tmux session `name`, with `tmux` the tmux to run (its full path, as an app
 * opened outside a shell may not have the launcher's PATH): `{command, args, file?}`, `file` being `{path, text}`
 * to write before running it. */
export function openWatch({app, tmux, name, platform = process.platform, home = homedir()}) {
    const attach = [tmux, 'attach', '-t', name]
    const line = attach.map(part => `'${part.replace(/'/g, "'\\''")}'`).join(' ')
    if (platform !== 'darwin') return {command: 'x-terminal-emulator', args: ['-e', ...attach]}
    if (app === 'iterm') return {command: 'osascript', args: appleWatch('iTerm', `tell current session of current window to write text ${appleString(line)}`, `create window with default profile command ${appleString(line)}`)}
    if (app === 'ghostty') return {command: 'open', args: ['-na', 'Ghostty', '--args', '-e', ...attach]}
    if (app === 'warp') {
        const text = [`name = "Watch ${name}"`, `title = "${name}"`, '', '[[panes]]', 'id = "watch"', 'type = "terminal"', `commands = [${JSON.stringify(line)}]`, ''].join('\n')
        return {command: 'open', args: ['warp://tab_config/orrery_watch?new_window=true'], file: {path: join(home, '.warp', 'tab_configs', 'orrery_watch.toml'), text}}
    }
    return {command: 'osascript', args: appleWatch('Terminal', `do script ${appleString(line)} in window 1`, `do script ${appleString(line)}`)}
}
