import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
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

    it("registers orrery's hook for the events its report reads, the tool ones in the background", () => {
        expect(claude.hooks.events).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'StopFailure', 'Notification', 'SessionEnd'])
        expect(claude.hooks.background).toEqual(['PreToolUse', 'PermissionRequest'])
        expect(claude.hooks.background.every((event: string) => claude.hooks.events.includes(event))).toBe(true)
    })

    it('claims what orrery offers only to a launcher that does it', () => {
        expect(claude.claims).toBe('untrusted=no-bash&chat=yes&model=yes&resume=yes&global=yes')
    })

    it("measures context off the hook's transcript, against its model's window, and says nothing when it can't tell", () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-claude-agent-'))
        const transcript = join(dir, 'session.jsonl')
        writeFileSync(transcript, `${JSON.stringify({type: 'assistant', message: {model: 'claude-sonnet-4-6', usage: {input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 990}}})}\n`)
        expect(claude.context({hook_event_name: 'Stop', transcript_path: transcript})).toEqual({tokens: 41_000, window: 200_000})
        expect(claude.context({hook_event_name: 'UserPromptSubmit', transcript_path: transcript})).toBeUndefined()
        expect(claude.context({hook_event_name: 'Stop', transcript_path: join(dir, 'none.jsonl')})).toBeUndefined()
        expect(claude.window('claude-opus-5-5', 10)).toBe(1_000_000)
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

// What the hook posts is the adapter's reading of Claude Code's hook input (ORR-1074), so the hook knows nothing of it.
describe("the Claude adapter's report", () => {
    it("passes Claude Code's events on by name, with the session, its folder and what started it", () => {
        expect(claude.report({hook_event_name: 'SessionStart', session_id: 'abc', cwd: '/repo', source: 'compact'}))
            .toMatchObject({id: 'abc', cwd: '/repo', event: 'SessionStart', source: 'compact'})
        expect(claude.report({hook_event_name: 'SessionEnd', session_id: 'abc', reason: 'clear'})).toMatchObject({event: 'SessionEnd', reason: 'clear'})
        expect(claude.report({}).event).toBe('idle')
    })

    it('reads a notification asking for a permission as waiting, with what it asks, and any other as idle', () => {
        expect(claude.report({hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash'}))
            .toMatchObject({event: 'waiting', message: 'Claude needs your permission to use Bash'})
        expect(claude.report({hook_event_name: 'Notification', message: 'Claude is waiting for your input'}).event).toBe('idle')
    })

    it("says the tool in a line, and a Bash command only on PreToolUse, never another tool's input", () => {
        const bash = claude.report({hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'git status'}})
        expect(bash).toMatchObject({command: 'git status', tool: {name: 'Bash', detail: 'git status'}})
        expect(claude.report({hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {command: 'git push'}}).command).toBeUndefined()
        expect(claude.report({hook_event_name: 'PreToolUse', tool_name: 'mcp__x__write', tool_input: {body: 'secret'}}).tool).toEqual({name: 'mcp__x__write', detail: undefined})
    })

    it("keeps what Claude Code said of a cut-off turn to StopFailure, capped", () => {
        const long = 'x'.repeat(500)
        expect(claude.report({hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: long})).toMatchObject({error: 'rate_limit', error_text: 'x'.repeat(300)})
        expect(claude.report({hook_event_name: 'Stop', last_assistant_message: 'done'}).error_text).toBeUndefined()
    })
})
