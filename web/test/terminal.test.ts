import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {openWatch} from '../../channel/terminal.mjs'

const watching = {tmux: '/opt/homebrew/bin/tmux', name: 'orrery-greenhouse-a1b2c3d4e5f6', platform: 'darwin', home: '/Users/me'}
const line = "'/opt/homebrew/bin/tmux' 'attach' '-t' 'orrery-greenhouse-a1b2c3d4e5f6'"

describe('opening a terminal on a session', () => {
    it('has Terminal run the attach through AppleScript, the default', () => {
        expect(openWatch({...watching, app: 'terminal'}).args).toEqual(['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script "${line}"`, '-e', 'end tell'])
        expect(openWatch({...watching, app: undefined}).command).toBe('osascript')
    })

    it('opens iTerm2 and Ghostty with the attach as their command', () => {
        expect(openWatch({...watching, app: 'iterm'}).args[1]).toBe(`tell application "iTerm" to create window with default profile command "${line}"`)
        expect(openWatch({...watching, app: 'ghostty'})).toEqual({command: 'open', args: ['-na', 'Ghostty', '--args', '-e', '/opt/homebrew/bin/tmux', 'attach', '-t', watching.name]})
    })

    it('has Warp run it from a tab config it writes first, in a new window', () => {
        const {command, args, file} = openWatch({...watching, app: 'warp'})
        expect([command, args]).toEqual(['open', ['warp://tab_config/orrery_watch?new_window=true']])
        expect(file.path).toBe('/Users/me/.warp/tab_configs/orrery_watch.toml')
        expect(file.text).toContain(`commands = [${JSON.stringify(line)}]\n`)
    })

    it("uses the system's own terminal off macOS, whatever the setting", () => {
        expect(openWatch({...watching, app: 'iterm', platform: 'linux'})).toEqual({command: 'x-terminal-emulator', args: ['-e', '/opt/homebrew/bin/tmux', 'attach', '-t', watching.name]})
    })
})
