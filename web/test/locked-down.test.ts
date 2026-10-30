import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {chatOnly, lockedDown} from '../../channel/locked-down.mjs'

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
    it('gets the hooks a repo keeps in its local settings, as nothing else says when its turn ends (ORR-744)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-repo-'))
        mkdirSync(join(dir, '.claude'))
        writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({hooks, permissions: {allow: ['Bash(curl:*)']}}))
        const args: string[] = chatOnly(dir, 'orrery-shop')
        expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({hooks})
    })

    it('gets both when a repo has hooks in each of its settings', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-repo-'))
        mkdirSync(join(dir, '.claude'))
        const other = {type: 'command', command: 'node other.mjs'}
        writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({hooks}))
        writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({hooks: {Stop: [{hooks: [other]}], Notification: [{hooks: [other]}]}}))
        const args: string[] = chatOnly(dir, 'orrery-shop')
        expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({
            hooks: {Stop: [...hooks.Stop, {hooks: [other]}], Notification: [{hooks: [other]}]},
        })
    })

    it('reads the repo and has the channel but its tools that take up work, with only the repo\'s hooks and servers', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-repo-'))
        mkdirSync(join(dir, '.claude'))
        writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({hooks, permissions: {allow: ['Bash(curl:*)']}}))
        const args: string[] = chatOnly(dir, 'orrery-shop')
        expect(args).toEqual(expect.arrayContaining(['--restricted', '--strict-mcp-config']))
        expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Grep,Glob'])
        expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'dontAsk'])
        expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({hooks})
        expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))).toEqual(['Read', 'Grep', 'Glob', 'mcp__orrery-shop'])
        expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual(['start_issue', 'finish_issue', 'update_issue', 'write_doc', 'egress', 'secrets', 'resolve_event'].map(t => `mcp__orrery-shop__${t}`))
    })
})
