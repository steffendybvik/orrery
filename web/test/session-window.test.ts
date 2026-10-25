import {describe, expect, it} from 'vitest'
// @ts-expect-error: the channel is plain JavaScript, run by node from other repos
import {isClaude} from '../../channel/session.mjs'

describe("a Claude window's process", () => {
    it('is claude itself, or node running it from an npm install', () => {
        expect(isClaude(['claude', '--dangerously-load-development-channels', 'server:orrery'])).toBe(true)
        expect(isClaude(['/Users/me/.local/bin/claude'])).toBe(true)
        expect(isClaude(['node', '/usr/local/bin/claude', '--resume'])).toBe(true)
        expect(isClaude(['/opt/node/bin/node', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'])).toBe(true)
    })

    it("isn't a shell or node running something else", () => {
        expect(isClaude(['node', '/src/larder/channel/orrery-hook.mjs'])).toBe(false)
        expect(isClaude(['/bin/zsh', '-c', 'claude'])).toBe(false)
        expect(isClaude(['node', '/Users/me/.claude/hooks/notify.mjs'])).toBe(false)
    })
})
