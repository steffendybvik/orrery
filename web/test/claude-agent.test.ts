import {describe, expect, it, vi} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {agentFor} from '../../channel/agents.mjs'
// @ts-expect-error: plain JavaScript, no types
import {claude} from '../../channel/claude-agent.mjs'
// @ts-expect-error: plain JavaScript, no types
import {chatOnly, lockedDown} from '../../channel/locked-down.mjs'

// The Claude Code adapter (ORR-1074): what the launcher did for Claude Code itself, moved, against a pane that shows
// set screens and records what's typed into it.
function paneShowing(...screens: string[]) {
    const done: string[] = []
    let at = 0
    return {
        done,
        read: () => screens[Math.min(at++, screens.length - 1)] ?? '',
        type: (text: string) => void done.push(`type ${text}`),
        press: (key: string) => void done.push(key),
    }
}

const PROMPT = ' Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again\n   3. No\n'

describe('the agents', () => {
    it('start Claude Code when none is named, and refuse one there is no adapter for', () => {
        expect(agentFor()).toBe(claude)
        expect(agentFor('claude')).toBe(claude)
        expect(() => agentFor('other')).toThrow('no agent other')
    })
})

describe('the Claude adapter', () => {
    it('starts claude with the channel, in the permission mode, on the model and effort asked for', () => {
        expect(claude.command({dir: '/repo', server: 'orrery', mode: 'auto', launch: {model: 'claude-opus-5-5', effort: 'high'}}))
            .toEqual(['claude', '--dangerously-load-development-channels', 'server:orrery', '--permission-mode', 'auto', '--model', 'claude-opus-5-5', '--effort', 'high'])
    })

    it('locks an untrusted launch down, and starts a chat on the owner\'s settings, taking its session up again', () => {
        expect(claude.command({dir: '/repo', server: 'orrery', mode: 'auto', launch: {untrusted: true}}).slice(3)).toEqual(lockedDown('/repo', 'orrery'))
        const resume = '0f8fad5b-d9cb-469f-a165-70867728950e'
        expect(claude.command({dir: '/repo', server: 'orrery', mode: 'auto', launch: {chat: true, resume}}).slice(3))
            .toEqual([...chatOnly('/repo', 'orrery'), '--resume', resume])
    })

    it('claims what orrery offers only to a launcher that does it', () => {
        expect(claude.claims).toBe('untrusted=no-bash&chat=yes&model=yes&resume=yes')
    })

    it('presses Enter or Escape only on a prompt on "Yes"', () => {
        const prompt = paneShowing(PROMPT)
        expect(claude.allow(prompt)).toBe(true)
        expect(claude.deny(prompt)).toBe(true)
        expect(prompt.done).toEqual(['Enter', 'Escape'])
        const none = paneShowing('> ')
        expect(claude.allow(none)).toBe(false)
        expect(claude.deny(none)).toBe(false)
        expect(none.done).toEqual([])
    })

    it('types /clear, then Enter', async () => {
        vi.useFakeTimers()
        const pane = paneShowing('')
        const cleared = claude.clear(pane)
        expect(pane.done).toEqual(['type /clear'])
        await vi.advanceTimersByTimeAsync(300)
        await cleared
        expect(pane.done).toEqual(['type /clear', 'Enter'])
        vi.useRealTimers()
    })

    it('accepts the channel flag\'s warning, stops on a folder not yet trusted, and says when it saw neither', async () => {
        vi.useFakeTimers()
        try {
            const warned = paneShowing('starting', 'Loading development channels\n❯ 1. I am using this for local development')
            const past = claude.getPast(warned, {dir: '/repo'})
            await vi.advanceTimersByTimeAsync(1000)
            expect(await past).toEqual({})
            expect(warned.done).toEqual(['Enter'])

            const untrusted = claude.getPast(paneShowing('Do you trust the files in this folder?'), {dir: '/repo'})
            await vi.advanceTimersByTimeAsync(500)
            expect((await untrusted).stop).toContain('run claude in /repo once by hand')

            const quiet = paneShowing('nothing yet')
            const stuck = claude.getPast(quiet, {dir: '/repo'})
            await vi.advanceTimersByTimeAsync(30_000)
            expect(await stuck).toEqual({stuck: "didn't see the channel's warning"})
            expect(quiet.done).toEqual([])
        } finally {
            vi.useRealTimers()
        }
    })
})
