import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {openWatch} from '../../channel/terminal.mjs'

const watching = {tmux: '/opt/homebrew/bin/tmux', name: 'orrery-greenhouse-a1b2c3d4e5f6', platform: 'darwin', home: '/Users/me'}
const line = "'/opt/homebrew/bin/tmux' 'attach' '-t' 'orrery-greenhouse-a1b2c3d4e5f6'"

describe('opening a terminal on a session', () => {
    /** The AppleScript lines an `osascript` call runs, one per `-e`. */
    const script = (app: string | undefined) => {
        const {command, args} = openWatch({...watching, app})
        expect(command).toBe('osascript')
        return args.filter((_: string, i: number) => i % 2 === 1)
    }

    it('has Terminal run the attach through AppleScript, the default, in the window it opens when it starts (ORR-564)', () => {
        const lines = script('terminal')
        expect(lines[0]).toBe('set wasRunning to application "Terminal" is running')
        // Not running: it opens a window as it starts, so the attach goes there rather than into a second, blank one.
        expect(lines).toContain(`do script "${line}" in window 1`)
        // Running: a new window of its own.
        expect(lines).toContain(`do script "${line}"`)
        expect(lines.indexOf(`do script "${line}" in window 1`)).toBeLessThan(lines.indexOf('else'))
        expect(lines.at(-2)).toBe('activate')
        expect(script(undefined)).toEqual(lines)
    })

    it('has iTerm2 write the attach into the window it opens when it starts, else open one with it', () => {
        const lines = script('iterm')
        expect(lines[0]).toBe('set wasRunning to application "iTerm" is running')
        expect(lines).toContain(`tell current session of current window to write text "${line}"`)
        expect(lines).toContain(`create window with default profile command "${line}"`)
    })

    it('opens Ghostty with the attach as its command', () => {
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
