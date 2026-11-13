import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {setUpUser, standsDown, undoUser, userMcpServer, userServer, withTrust, withUserHooks, withoutUserHooks} from '../../channel/claude-user-setup.mjs'
// @ts-expect-error: plain JavaScript, no types
import {commandsFor} from '../../channel/home-folder.mjs'
// @ts-expect-error: plain JavaScript, no types
import {HOOK_EVENTS} from '../../channel/claude-hooks.mjs'

// What the install line puts in Claude Code's own config, for every folder (ORR-1067).
const URL = 'http://localhost:9010'
const ORRERY = {id: 'orr_abc123', environment: 'personal'}
const COMMANDS = commandsFor({bootstrap: '/Users/me/.orrery/bootstrap.mjs'})
const HOME = '/Users/me/.orrery/orr_abc123/home'
const at = {url: URL, orrery: ORRERY, commands: COMMANDS}

type Group = {matcher?: string, hooks: {type: string, command: string}[]}
type Settings = {hooks?: Record<string, Group[]>, [key: string]: unknown}

const files = () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-user-'))
    return {settings: join(dir, '.claude', 'settings.json'), state: join(dir, '.claude.json')}
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

describe("the install line's user-level setup", () => {
    it('adds one server per orrery, serving every project, marked as the install\'s', () => {
        expect(userServer(at)).toEqual({
            name: 'orrery-personal',
            config: {type: 'stdio', command: 'node', args: ['/Users/me/.orrery/bootstrap.mjs', 'channel'], env: {ORRERY_URL: URL, ORRERY_ID: 'orr_abc123', ORRERY_PROJECTS: '*', ORRERY_SCOPE: 'user'}},
        })
        expect(() => userServer({...at, orrery: {id: '$(rm -rf ~)'}})).toThrow("won't write")
        expect(() => userServer({...at, url: 'http://x; rm -rf ~'})).toThrow("can't go into a hook's command")
    })

    it("puts orrery's hook on every event beside the owner's own, once however often it runs", () => {
        const mine: Settings = {model: 'opus', hooks: {Stop: [{hooks: [{type: 'command', command: 'say done'}]}]}}
        const once = withUserHooks(mine, at)
        const twice = withUserHooks(once, at)
        expect(twice).toEqual(once)
        expect(Object.keys(twice.hooks)).toEqual(expect.arrayContaining(HOOK_EVENTS))
        expect(twice.model).toBe('opus')
        expect(twice.hooks.Stop.map((g: Group) => g.hooks[0]!.command)).toEqual(['say done', `ORRERY_SCOPE=user ORRERY_URL=${URL} ORRERY_ID=orr_abc123 node "/Users/me/.orrery/bootstrap.mjs" hook`])
        // Taking them out leaves the owner's as they were.
        expect(withoutUserHooks(twice)).toEqual(mine)
        expect(withoutUserHooks(withUserHooks({}, at))).toEqual({})
    })

    it("leaves a repo's orrery hook, written without the mark, alone", () => {
        const repo: Settings = {hooks: {Stop: [{hooks: [{type: 'command', command: `ORRERY_URL=${URL} ORRERY_PROJECT=orrery node "$HOME/.orrery/bootstrap.mjs" hook`}]}]}}
        expect(withoutUserHooks(repo)).toEqual(repo)
    })

    it('trusts the default folder, and untrusts it only if it was the one to trust it', () => {
        const trusted = withTrust({projects: {'/code/app': {hasTrustDialogAccepted: true}}}, HOME)
        expect(trusted.projects[HOME]).toEqual({hasTrustDialogAccepted: true, orreryTrusted: true})
        expect(withTrust(trusted, HOME, false).projects[HOME]).toEqual({hasTrustDialogAccepted: false})
        expect(withTrust(trusted, '/code/app', false).projects['/code/app']).toEqual({hasTrustDialogAccepted: true})
    })

    it('sets up through claude mcp and the two files, and undoes all of it', () => {
        const where = files()
        mkdirSync(join(where.settings, '..'), {recursive: true})
        writeFileSync(where.settings, JSON.stringify({theme: 'dark'}))
        const ran: string[][] = []
        // A stand-in for `claude mcp`, writing the server into the state file as Claude Code does.
        const run = (args: string[]) => {
            ran.push(args)
            const state = (() => {
                try {
                    return readJson(where.state)
                } catch {
                    return {}
                }
            })()
            if (args[1] === 'add-json') state.mcpServers = {...state.mcpServers, [args[4]!]: JSON.parse(args[5]!)}
            if (args[1] === 'remove') {
                if (!state.mcpServers?.[args[4]!]) throw new Error('no such server')
                delete state.mcpServers[args[4]!]
            }
            writeFileSync(where.state, JSON.stringify(state))
        }
        expect(setUpUser({...at, home: HOME, run, files: where})).toEqual({server: 'orrery-personal', settings: where.settings})
        setUpUser({...at, home: HOME, run, files: where})
        expect(ran.filter(args => args[1] === 'add-json')).toHaveLength(2)
        expect(Object.keys(readJson(where.state).mcpServers)).toEqual(['orrery-personal'])
        expect(readJson(where.state).projects[HOME].hasTrustDialogAccepted).toBe(true)
        expect(readJson(where.settings).theme).toBe('dark')
        expect(readJson(where.settings).hooks.SessionStart).toHaveLength(1)

        expect(undoUser({run, homeOf: (id: string) => `/Users/me/.orrery/${id}/home`, files: where})).toEqual(['orrery-personal'])
        expect(readJson(where.state).mcpServers).toEqual({})
        expect(readJson(where.state).projects[HOME].hasTrustDialogAccepted).toBe(false)
        expect(readJson(where.settings)).toEqual({theme: 'dark'})

        // On an orrery serving `/mcp` (ORR-1102): it beside the channel, which lists only its own tools; both undone.
        setUpUser({...at, home: HOME, run, mcp: true, files: where})
        const servers = readJson(where.state).mcpServers
        expect(Object.keys(servers)).toEqual(['orrery-personal', 'orrery-personal-api'])
        expect(servers['orrery-personal'].env.ORRERY_TOOLS).toBe('local')
        // Run again without it (the orrery stopped serving it), the `/mcp` entry goes and the channel has every tool.
        setUpUser({...at, home: HOME, run, mcp: true, files: where})
        setUpUser({...at, home: HOME, run, files: where})
        expect(Object.keys(readJson(where.state).mcpServers)).toEqual(['orrery-personal'])
        expect(readJson(where.state).mcpServers['orrery-personal'].env.ORRERY_TOOLS).toBeUndefined()
        setUpUser({...at, home: HOME, run, mcp: true, files: where})
        expect(undoUser({run, homeOf: (id: string) => `/Users/me/.orrery/${id}/home`, files: where})).toEqual(['orrery-personal'])
        expect(readJson(where.state).mcpServers).toEqual({})
    })

    it("names orrery's /mcp as the launcher does, with a helper marked as the install's", () => {
        expect(userMcpServer(at)).toEqual({
            name: 'orrery-personal-api',
            config: {type: 'http', url: `${URL}/mcp`, headersHelper: `ORRERY_SCOPE=user ORRERY_URL=${URL} ORRERY_ID=orr_abc123 node "/Users/me/.orrery/bootstrap.mjs" headers`},
        })
        expect(() => userMcpServer({...at, url: 'http://x; rm -rf ~'})).toThrow("can't go into a hook's command")
    })
})

describe('the user-level hook', () => {
    const folder = (hook?: string) => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-folder-'))
        if (hook) {
            mkdirSync(join(dir, '.claude'))
            writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({hooks: {Stop: [{hooks: [{type: 'command', command: hook}]}]}}))
        }
        return dir
    }

    it("is the repo's own hook's to skip: that one always runs", () => {
        expect(standsDown({env: {}, dir: folder()})).toBe(false)
        expect(standsDown({env: {ORRERY_PROJECT: 'orrery'}, dir: folder()})).toBe(false)
    })

    it('says nothing where the folder has orrery\'s hook of its own, or no project is known', () => {
        const user = {ORRERY_SCOPE: 'user', ORRERY_PROJECT: 'reading-list'}
        expect(standsDown({env: user, dir: folder()})).toBe(false)
        expect(standsDown({env: user, dir: folder('ORRERY_URL=x node "/Users/me/.orrery/bootstrap.mjs" hook')})).toBe(true)
        expect(standsDown({env: user, dir: folder('node /code/orrery/channel/orrery-hook.mjs')})).toBe(true)
        expect(standsDown({env: user, dir: folder('say done')})).toBe(false)
        expect(standsDown({env: {ORRERY_SCOPE: 'user'}, dir: folder()})).toBe(true)
        // Another orrery started it (ORR-1071): that orrery's hook reports it, this one's says nothing.
        const started = {ORRERY_SCOPE: 'user', ORRERY_ID: 'orr_personal', ORRERY_PROJECT: 'reading-list'}
        expect(standsDown({env: {...started, ORRERY_STARTED_ON: 'orr_work'}, dir: folder()})).toBe(true)
        expect(standsDown({env: {...started, ORRERY_STARTED_ON: 'orr_personal'}, dir: folder()})).toBe(false)
        // The project the launcher's list maps the folder to (ORR-1068) is one known.
        expect(standsDown({env: {ORRERY_SCOPE: 'user'}, dir: folder(), project: 'reading-list'})).toBe(false)
        expect(standsDown({env: {ORRERY_SCOPE: 'user'}, dir: folder('node /code/orrery/channel/orrery-hook.mjs'), project: 'reading-list'})).toBe(true)
    })
})
