import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {chatOnly, lockedDown} from '../../channel/locked-down.mjs'
// @ts-expect-error: the channel is plain JavaScript, run by node on the host
import {NOT_FOR_CHAT} from '../../channel/tools.mjs'

const hooks = {Stop: [{hooks: [{type: 'command', command: 'node channel/orrery-hook.mjs'}]}]}

describe("an untrusted schedule's session", () => {
    it('gets none of Claude Code\'s own tools, no Bash among them, and the channel but egress and secrets, refusing the rest, with only the repo\'s hooks and servers', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-repo-'))
        mkdirSync(join(dir, '.claude'))
        writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({hooks, permissions: {allow: ['Bash(curl:*)']}}))
        const args: string[] = lockedDown(dir, 'orrery-shop')
        expect(args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config']))
        expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', ''])
        expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk'])
        expect(args[args.indexOf('--mcp-config') + 1]).toBe(join(dir, '.mcp.json'))
        // The repo's hooks, and nothing else from its settings: not its allow list.
        expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({hooks})
        const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
        expect(allowed).toEqual(['mcp__orrery-shop'])
        expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual(['update_issue', 'start_issue', 'finish_issue', 'write_doc', 'secrets', 'egress', 'events', 'resolve_event', 'more_tools'].map(t => `mcp__orrery-shop__${t}`))
    })

    it('starts with no hooks in a repo that has none', () => {
        const args: string[] = lockedDown(mkdtempSync(join(tmpdir(), 'orrery-repo-')), 'orrery')
        expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({hooks: {}})
    })
})

describe("the owner's chat", () => {
    it('starts with the owner\'s own settings, as a terminal does: nothing restricted, no fixed tools and nothing refused unasked (ORR-750)', () => {
        const args: string[] = chatOnly('/repo', 'orrery-shop')
        for (const flag of ['--restricted', '--tools', '--permission-mode', '--settings', '--strict-mcp-config', '--mcp-config']) expect(args).not.toContain(flag)
    })

    it('has the channel without asking, and leaves Claude Code\'s own tools to the owner\'s settings, but not the channel\'s tools that take up work', () => {
        const args: string[] = chatOnly('/repo', 'orrery-shop')
        expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))).toEqual(['mcp__orrery-shop'])
        const refused = args.slice(args.indexOf('--disallowedTools') + 1)
        expect(refused).toEqual(NOT_FOR_CHAT.map((tool: string) => `mcp__orrery-shop__${tool}`))
    })
})
