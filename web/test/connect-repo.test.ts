import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it, vi} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {choose, connector, folderProblem, pickerFor} from '../../channel/connect-repo.mjs'

// The launcher's part of Connect a repo (ORR-708): which picker opens, and that it only ever writes to the folder chosen.
const URL = 'http://localhost:9010'
const ORRERY = {id: 'orr_abc123', environment: 'personal'}
const PROJECTS = [{id: 'shop', key: 'SHO'}]

function bench() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orrery-connect-')))
    const [home, chosen, other] = ['home', 'shop', 'other'].map(part => join(root, part)) as [string, string, string]
    for (const dir of [home, chosen, other]) mkdirSync(dir)
    mkdirSync(join(home, '.orrery'))
    const told: Record<string, unknown>[] = []
    const served: [string, string[]][] = []
    const opened: Record<string, unknown>[] = []
    const fetch = vi.fn(async () => new Response('// bootstrap', {status: 200}))
    const make = (pick: () => Promise<string | null>, claimed = true) => connector({
        url: URL, orreryId: ORRERY.id, picker: {command: 'picker', args: []}, home, fetch, pick, log: () => {},
        tell: async (_id: string, body: Record<string, unknown>) => {
            told.push(body)
            return {claimed}
        },
        serve: (dir: string, projects: string[]) => served.push([dir, projects]),
        open: (args: Record<string, unknown>) => {
            opened.push(args)
            return true
        },
    })
    return {home, chosen, other, told, served, opened, fetch, make}
}

describe("the launcher's folder picker", () => {
    it("uses the machine's own, and none where it has none", () => {
        expect(pickerFor({platform: 'darwin'}).command).toBe('osascript')
        const has = (name: string) => name === 'kdialog'
        expect(pickerFor({platform: 'linux', env: {DISPLAY: ':0'}, has}).command).toBe('kdialog')
        expect(pickerFor({platform: 'linux', env: {WAYLAND_DISPLAY: 'w'}, has: () => true}).command).toBe('zenity')
        expect(pickerFor({platform: 'linux', env: {}, has: () => true})).toBeNull()
        expect(pickerFor({platform: 'linux', env: {DISPLAY: ':0'}, wsl: true, has: () => true})).toBeNull()
        expect(pickerFor({platform: 'linux', env: {DISPLAY: ':0'}, has: () => false})).toBeNull()
        expect(pickerFor({platform: 'win32'})).toBeNull()
    })

    it('says the folder chosen, without its last slash, and nothing for a cancel', async () => {
        const answering = (error: unknown, stdout: string, stderr = '') => ((_c: string, _a: string[], _o: unknown, done: (...args: unknown[]) => void) => done(error, stdout, stderr))
        const picker = {command: 'picker', args: []}
        expect(await choose(picker, answering(null, '/Users/ada/shop/\n'))).toBe('/Users/ada/shop')
        expect(await choose(picker, answering({code: 1}, '', 'execution error: User canceled. (-128)'))).toBeNull()
        expect(await choose(picker, answering({code: 1}, ''))).toBeNull()
        await expect(choose(picker, answering({code: 1}, '', 'execution error: Not authorised. (-1743)'))).rejects.toThrow(/Not authorised/)
    })

    it("won't take the home folder or the root", () => {
        expect(folderProblem('/Users/ada', '/Users/ada')).toMatch(/isn't a repo/)
        expect(folderProblem('/', '/Users/ada')).toMatch(/isn't a repo/)
        expect(folderProblem('/Users/ada/shop', '/Users/ada')).toBeNull()
    })
})

describe('a connect request on the launcher', () => {
    it('tells orrery the folder\'s name and never its path, then writes there and opens Claude', async () => {
        const {chosen, told, served, opened, make} = bench()
        const handler = make(async () => chosen)
        await handler.pick({id: 'c1'})
        expect(told[0]).toEqual({state: 'picking'})
        expect(told[1]).toEqual({state: 'picked', folder: 'shop', projects: [], every: false})
        expect(JSON.stringify(told)).not.toContain(chosen)
        await handler.write({id: 'c1', projects: PROJECTS, orrery: ORRERY, terminal: 'iterm'})
        expect(existsSync(join(chosen, '.mcp.json'))).toBe(true)
        expect(served).toEqual([[chosen, ['shop']]])
        expect(opened[0]).toMatchObject({dir: chosen, server: 'orrery-personal', terminal: 'iterm'})
        expect(told.at(-1)).toEqual({state: 'done', written: ['.mcp.json', '.claude/settings.json', 'CLAUDE.md'], unchanged: [], opened: true})
    })

    it('opens no picker when another launcher has the request', async () => {
        const {told, make} = bench()
        const pick = vi.fn(async () => null)
        await make(pick, false).pick({id: 'c1'})
        expect(pick).not.toHaveBeenCalled()
        expect(told).toEqual([{state: 'picking'}])
    })

    it('writes nothing for a request it chose no folder for, whatever orrery sends', async () => {
        const {other, told, served, make} = bench()
        const handler = make(async () => null)
        await handler.pick({id: 'c1'})
        expect(told.at(-1)).toEqual({state: 'canceled'})
        // A folder in the message counts for nothing: there's no field for it.
        await handler.write({id: 'c1', projects: PROJECTS, orrery: ORRERY, terminal: 'iterm', dir: other, folder: other})
        await handler.write({id: 'c2', projects: PROJECTS, orrery: ORRERY, terminal: 'iterm', dir: other})
        expect(existsSync(join(other, '.mcp.json'))).toBe(false)
        expect(served).toEqual([])
    })

    it('says what went wrong, and takes each folder for one write', async () => {
        const {chosen, home, told, make} = bench()
        const handler = make(async () => home)
        await handler.pick({id: 'home'})
        expect(told.at(-1)).toMatchObject({state: 'failed'})
        const bad = make(async () => chosen)
        await bad.pick({id: 'c1'})
        await bad.write({id: 'c1', projects: [{id: 'no good', key: 'A'}], orrery: ORRERY, terminal: 'iterm'})
        expect(told.at(-1)).toMatchObject({state: 'failed'})
        expect(existsSync(join(chosen, '.mcp.json'))).toBe(false)
        const count = told.length
        await bad.write({id: 'c1', projects: PROJECTS, orrery: ORRERY, terminal: 'iterm'})
        expect(told).toHaveLength(count)
    })

    it('puts the bootstrap on a machine that lacks it, from this machine or https only', async () => {
        const root = bench()
        const home = join(root.chosen, 'fresh')
        mkdirSync(home)
        const handler = connector({url: 'http://localhost:9010', orreryId: ORRERY.id, picker: {}, home, fetch: root.fetch, pick: async () => root.chosen, log: () => {}, tell: async () => ({claimed: true}), serve: () => {}, open: () => true})
        await handler.pick({id: 'c1'})
        await handler.write({id: 'c1', projects: PROJECTS, orrery: ORRERY, terminal: 'iterm'})
        expect(readFileSync(join(home, '.orrery', 'bootstrap.mjs'), 'utf8')).toBe('// bootstrap')
        const said: Record<string, unknown>[] = []
        const remote = connector({url: 'http://192.168.1.5:9000', orreryId: ORRERY.id, picker: {}, home: join(home, 'none'), fetch: root.fetch, pick: async () => root.other, log: () => {}, tell: async (_: string, body: Record<string, unknown>) => {
            said.push(body)
            return {claimed: true}
        }, serve: () => {}, open: () => true})
        await remote.pick({id: 'c2'})
        await remote.write({id: 'c2', projects: PROJECTS, orrery: ORRERY, terminal: 'iterm'})
        expect(said.at(-1)).toMatchObject({state: 'failed', message: expect.stringContaining("isn't on this machine or https")})
        expect(existsSync(join(root.other, '.mcp.json'))).toBe(false)
    })
})
