import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {lockedDown} from '../../channel/locked-down.mjs'

const hooks = {Stop: [{hooks: [{type: 'command', command: 'node channel/orrery-hook.mjs'}]}]}

describe("an untrusted schedule's session", () => {
    it('gets gh issue list/view and the channel but egress and secrets, refusing the rest, with only the repo\'s hooks and servers', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-repo-'))
        mkdirSync(join(dir, '.claude'))
        writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({hooks, permissions: {allow: ['Bash(curl:*)']}}))
        const args: string[] = lockedDown(dir, 'orrery-shop')
        expect(args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config']))
        expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'Bash'])
        expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk'])
        expect(args[args.indexOf('--mcp-config') + 1]).toBe(join(dir, '.mcp.json'))
        // The repo's hooks, and nothing else from its settings: not its allow list.
        expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({hooks})
        const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
        expect(allowed).toEqual(['Bash(gh issue list:*)', 'Bash(gh issue view:*)', 'mcp__orrery-shop'])
        expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual(['mcp__orrery-shop__egress', 'mcp__orrery-shop__secrets'])
    })

    it('starts with no hooks in a repo that has none', () => {
        const args: string[] = lockedDown(mkdtempSync(join(tmpdir(), 'orrery-repo-')), 'orrery')
        expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({hooks: {}})
    })
})
