import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {commandsFor, HOME_CLAUDE_MD, homeFiles, homeFolder, homeProjects, setUpHome} from '../../channel/home-folder.mjs'
// @ts-expect-error: plain JavaScript, no types
import {lockedDown} from '../../channel/locked-down.mjs'
// @ts-expect-error: plain JavaScript, no types
import {channelFor, channelsIn, servesEvery} from '../../channel/repo-channels.mjs'

// The default folder the launcher serves an orrery's projects with no repo from (ORR-1066).
const URL = 'http://localhost:9010'
const ORRERY = {id: 'orr_abc123', environment: 'personal'}
const BOOTSTRAP = {bootstrap: '/Users/me/.orrery/bootstrap.mjs'}

describe('the default folder', () => {
    it("is one per orrery, named from its id alone", () => {
        expect(homeFolder('orr_abc123', '/Users/me')).toBe('/Users/me/.orrery/orr_abc123/home')
        expect(() => homeFolder('../etc', '/Users/me')).toThrow("won't make a folder")
        expect(() => homeFolder(undefined, '/Users/me')).toThrow()
    })

    it("has the channel for every project, and orrery's hooks with no project fixed", () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-home-'))
        const {server, created, written} = setUpHome(dir, {url: URL, orrery: ORRERY, commands: commandsFor(BOOTSTRAP)})
        expect([server, created, written]).toEqual(['orrery-personal', true, ['.mcp.json', '.claude/settings.json', 'CLAUDE.md']])
        // What the launcher reads from a repo it reads from here the same way.
        expect(channelsIn(dir).map((c: {name: string}) => c.name)).toEqual(['orrery-personal'])
        expect(channelFor(dir, URL, 'reading-list').env).toEqual({ORRERY_URL: URL, ORRERY_ID: 'orr_abc123', ORRERY_PROJECTS: '*', ORRERY_PERSON: '${ORRERY_PERSON:-}'})
        expect(servesEvery(dir, URL, 'reading-list')).toBe(true)
        const settings = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'))
        const command = settings.hooks.Stop[0].hooks[0].command
        expect(command).toBe(`ORRERY_URL=${URL} ORRERY_ID=orr_abc123 node "/Users/me/.orrery/bootstrap.mjs" hook`)
        expect(command).not.toContain('ORRERY_PROJECT')
        expect(Object.keys(settings.hooks)).toHaveLength(8)
        expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(HOME_CLAUDE_MD)
        // An untrusted schedule's session there loads only this folder's channel and hooks.
        const flags = lockedDown(dir, server)
        expect(flags[flags.indexOf('--mcp-config') + 1]).toBe(join(dir, '.mcp.json'))
        expect(JSON.parse(flags[flags.indexOf('--settings') + 1]).hooks.Stop[0].hooks[0].command).toBe(command)
    })

    it('is safe to set up again, putting back what was changed', () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-home-'))
        setUpHome(dir, {url: URL, orrery: ORRERY, commands: commandsFor(BOOTSTRAP)})
        expect(setUpHome(dir, {url: URL, orrery: ORRERY, commands: commandsFor(BOOTSTRAP)})).toMatchObject({created: false, written: []})
        writeFileSync(join(dir, 'CLAUDE.md'), 'something else')
        expect(setUpHome(dir, {url: URL, orrery: ORRERY, commands: commandsFor(BOOTSTRAP)})).toMatchObject({created: false, written: ['CLAUDE.md']})
    })

    it("runs a checkout's channel and hook when no bootstrap runs the launcher", () => {
        const {files} = homeFiles({url: URL, orrery: ORRERY, commands: commandsFor({checkout: '/code/orrery/channel'})})
        expect(JSON.parse(files['.mcp.json']).mcpServers['orrery-personal'].args).toEqual(['/code/orrery/channel/orrery-channel.mjs'])
        expect(JSON.parse(files['.claude/settings.json']).hooks.Stop[0].hooks[0].command).toContain('node "/code/orrery/channel/orrery-hook.mjs"')
    })

    it("puts nothing a shell would read as more into a hook's command", () => {
        expect(() => homeFiles({url: 'http://x;rm -rf ~', orrery: ORRERY, commands: commandsFor(BOOTSTRAP)})).toThrow("can't go into a hook's command")
        expect(() => commandsFor({checkout: '/code/$(whoami)/channel'})).toThrow("can't go into a hook's command")
        expect(() => homeFiles({url: URL, orrery: {id: 'a b'}, commands: commandsFor(BOOTSTRAP)})).toThrow("won't write")
    })

    it("serves the projects with no repo that this machine's list doesn't serve from a repo", () => {
        const projects = [{id: 'reading-list'}, {id: 'orrery', repo: 'https://github.com/me/orrery'}, {id: 'notes'}, {id: 'garden', repo: ''}]
        const listed = [{url: URL, project: 'notes', dir: '/code/notes'}, {url: 'http://localhost:9020', project: 'garden', dir: '/code/garden'}]
        expect(homeProjects(projects, listed, URL)).toEqual(['reading-list', 'garden'])
    })
})
