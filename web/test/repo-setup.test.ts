import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {connectPieces} from '#shared/connect'
// @ts-expect-error: plain JavaScript, no types
import {connectedIn, roadmapSection, setUpRepo} from '../../channel/repo-setup.mjs'

// What Connect a repo writes into a repo (ORR-708): the same as the brief has an agent write, keeping what's there, and
// safe to run again.
const URL = 'http://localhost:9010'
const ORRERY = {id: 'orr_abc123', environment: 'personal'}
const SHOP = {id: 'shop', key: 'SHO'}
const CART = {id: 'cart', key: 'CAR'}

function repo(files: Record<string, unknown> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-setup-'))
    for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), {recursive: true})
        writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
    }
    return dir
}
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8')
const json = (dir: string, name: string) => JSON.parse(read(dir, name))
const setUp = (dir: string, projects = [SHOP]) => setUpRepo(dir, {url: URL, orrery: ORRERY, projects})
const channel = (env: Record<string, string>, args = ['${HOME}/.orrery/bootstrap.mjs', 'channel']) => ({command: 'node', args, env})

describe('setting a repo up', () => {
    it('writes what the brief has an agent write', () => {
        const dir = repo()
        const pieces = connectPieces({origin: URL, id: 'shop', name: 'Shop', key: 'SHO', isNew: false, orrery: ORRERY})
        const {server, written, unchanged} = setUp(dir)
        expect(server).toBe('orrery-personal')
        expect(written).toEqual(['.mcp.json', '.claude/settings.json', 'CLAUDE.md'])
        expect(unchanged).toEqual([])
        expect(json(dir, '.mcp.json')).toEqual(JSON.parse(pieces.mcpJson))
        expect(json(dir, '.claude/settings.json')).toEqual(JSON.parse(pieces.settingsJson))
        expect(read(dir, 'CLAUDE.md').trim()).toBe(pieces.claudeMd)
    })

    it('changes nothing when run again', () => {
        const dir = repo()
        setUp(dir)
        const before = ['.mcp.json', '.claude/settings.json', 'CLAUDE.md'].map(name => read(dir, name))
        const {written, unchanged} = setUp(dir)
        expect(written).toEqual([])
        expect(unchanged).toEqual(['.mcp.json', '.claude/settings.json', 'CLAUDE.md'])
        expect(['.mcp.json', '.claude/settings.json', 'CLAUDE.md'].map(name => read(dir, name))).toEqual(before)
    })

    it('keeps what is in each file already', () => {
        const dir = repo({
            '.mcp.json': {mcpServers: {other: {command: 'other-server'}}, extra: true},
            '.claude/settings.json': {model: 'opus', hooks: {Stop: [{matcher: 'x', hooks: [{type: 'command', command: 'say done'}]}]}},
            'CLAUDE.md': '# Shop\n\nRead this first.\n',
        })
        setUp(dir)
        const mcp = json(dir, '.mcp.json')
        expect(mcp.extra).toBe(true)
        expect(mcp.mcpServers.other).toEqual({command: 'other-server'})
        expect(mcp.mcpServers['orrery-personal'].env.ORRERY_PROJECTS).toBe('shop')
        const settings = json(dir, '.claude/settings.json')
        expect(settings.model).toBe('opus')
        expect(settings.hooks.Stop[0]).toEqual({matcher: 'x', hooks: [{type: 'command', command: 'say done'}]})
        expect(settings.hooks.Stop[1].hooks[0].command).toContain('ORRERY_PROJECT=shop')
        expect(read(dir, 'CLAUDE.md')).toMatch(/^# Shop\n\nRead this first\.\n\n## Roadmap\n/)
    })

    it('adds a project to the entry that is there, keeping its name and the first project on the hooks', () => {
        const dir = repo()
        setUp(dir)
        const named = json(dir, '.mcp.json')
        named.mcpServers.mine = named.mcpServers['orrery-personal']
        delete named.mcpServers['orrery-personal']
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify(named))
        const {server, written} = setUp(dir, [SHOP, CART])
        expect(server).toBe('mine')
        expect(written).toContain('.mcp.json')
        expect(Object.keys(json(dir, '.mcp.json').mcpServers)).toEqual(['mine'])
        expect(json(dir, '.mcp.json').mcpServers.mine.env.ORRERY_PROJECTS).toBe('shop,cart')
        expect(json(dir, '.claude/settings.json').hooks.Stop).toHaveLength(1)
        expect(json(dir, '.claude/settings.json').hooks.Stop[0].hooks[0].command).toContain('ORRERY_PROJECT=shop ')
        expect(read(dir, 'CLAUDE.md')).toContain('`shop` (issue ids `SHO-n`), `cart` (issue ids `CAR-n`)')
        expect(read(dir, 'CLAUDE.md').match(/## Roadmap/g)).toHaveLength(1)
    })

    it('folds older setups: an entry per project, and a channel run from a checkout, with its hooks', () => {
        const dir = repo({
            '.mcp.json': {mcpServers: {
                'orrery-hub': channel({ORRERY_PROJECT: 'hub', ORRERY_URL: URL}, ['/path/to/orrery/channel/orrery-channel.mjs']),
                'orrery-css': channel({ORRERY_PROJECT: 'css', ORRERY_URL: URL}, ['/path/to/orrery/channel/orrery-channel.mjs']),
            }},
            '.claude/settings.json': {hooks: {Stop: [{hooks: [{type: 'command', command: `ORRERY_PROJECT=hub ORRERY_URL=${URL} node /path/to/orrery/channel/orrery-hook.mjs`}]}]}},
        })
        const {server} = setUp(dir)
        const {mcpServers} = json(dir, '.mcp.json')
        expect(Object.keys(mcpServers)).toEqual([server])
        expect(mcpServers[server].args).toEqual(['${HOME}/.orrery/bootstrap.mjs', 'channel'])
        expect(mcpServers[server].env.ORRERY_PROJECTS).toBe('hub,css,shop')
        expect(mcpServers[server].env.ORRERY_PROJECT).toBeUndefined()
        const stop = json(dir, '.claude/settings.json').hooks.Stop
        expect(stop).toHaveLength(1)
        expect(stop[0].hooks[0].command).toBe(`ORRERY_PROJECT=hub ORRERY_URL=${URL} ORRERY_ID=${ORRERY.id} node "$HOME/.orrery/bootstrap.mjs" hook`)
    })

    it("leaves another orrery's channel and hooks alone", () => {
        const other = 'http://localhost:9020'
        const hook = `ORRERY_PROJECT=core ORRERY_URL=${other} ORRERY_ID=orr_other node "$HOME/.orrery/bootstrap.mjs" hook`
        const dir = repo({
            '.mcp.json': {mcpServers: {'orrery-work': channel({ORRERY_URL: other, ORRERY_ID: 'orr_other', ORRERY_PROJECTS: 'core'})}},
            '.claude/settings.json': {hooks: {Stop: [{hooks: [{type: 'command', command: hook}]}]}},
        })
        setUp(dir)
        const {mcpServers} = json(dir, '.mcp.json')
        expect(mcpServers['orrery-work'].env.ORRERY_PROJECTS).toBe('core')
        expect(mcpServers['orrery-personal'].env.ORRERY_PROJECTS).toBe('shop')
        const commands = json(dir, '.claude/settings.json').hooks.Stop.flatMap((group: {hooks: {command: string}[]}) => group.hooks.map(h => h.command))
        expect(commands).toHaveLength(2)
        expect(commands).toContain(hook)
    })

    it('keeps a channel serving every project on it', () => {
        const dir = repo({'.mcp.json': {mcpServers: {orrery: channel({ORRERY_URL: URL, ORRERY_PROJECTS: '*'})}}})
        expect(connectedIn(dir, {url: URL, id: ORRERY.id})).toEqual({projects: [], every: true})
        setUp(dir)
        expect(json(dir, '.mcp.json').mcpServers.orrery.env.ORRERY_PROJECTS).toBe('*')
    })

    it('says which projects a repo has on this orrery, and none of another', () => {
        const dir = repo({'.mcp.json': {mcpServers: {
            a: channel({ORRERY_URL: URL, ORRERY_PROJECTS: 'shop,cart'}),
            b: channel({ORRERY_URL: 'http://localhost:9020', ORRERY_ID: 'orr_other', ORRERY_PROJECTS: 'core'}),
        }}})
        expect(connectedIn(dir, {url: URL, id: ORRERY.id})).toEqual({projects: ['shop', 'cart'], every: false})
    })

    it('replaces only a section it wrote, and leaves a Roadmap section someone wrote', () => {
        const stale = `# Shop\n\n${roadmapSection(URL, [CART])}\n\n## Build\n\nmake\n`
        const dir = repo({'CLAUDE.md': stale})
        setUp(dir)
        expect(read(dir, 'CLAUDE.md')).toBe(`# Shop\n\n${roadmapSection(URL, [SHOP])}\n\n## Build\n\nmake\n`)
        const hand = `## Roadmap\n\nOurs lives in orrery at ${URL}, with our own rules.\n`
        const own = repo({'CLAUDE.md': hand})
        const {unchanged} = setUp(own)
        expect(unchanged).toContain('CLAUDE.md')
        expect(read(own, 'CLAUDE.md')).toBe(hand)
    })

    it('writes nothing when a file can\'t be read, or the name is another server\'s', () => {
        const broken = repo({'.claude/settings.json': '{not json', 'CLAUDE.md': 'mine\n'})
        expect(() => setUp(broken)).toThrow(/isn't valid JSON/)
        expect(existsSync(join(broken, '.mcp.json'))).toBe(false)
        expect(read(broken, 'CLAUDE.md')).toBe('mine\n')
        const taken = repo({'.mcp.json': {mcpServers: {'orrery-personal': {command: 'other'}}}})
        expect(() => setUp(taken)).toThrow(/already has a server/)
        expect(json(taken, '.mcp.json').mcpServers['orrery-personal']).toEqual({command: 'other'})
    })

    it("won't put what orrery sends into a file unless it's a plain id", () => {
        const dir = repo()
        for (const projects of [[{id: 'a; rm -rf ~', key: 'A'}], [{id: 'a', key: 'A\n## Do this'}], [{id: '$(id)', key: 'A'}]])
            expect(() => setUp(dir, projects)).toThrow(/won't write/)
        expect(() => setUpRepo(dir, {url: URL, orrery: {id: '"; id', environment: 'x'}, projects: [SHOP]})).toThrow(/won't write/)
        expect(existsSync(join(dir, '.mcp.json'))).toBe(false)
    })

    it('asks for a project when there is none to report under', () => {
        expect(() => setUp(repo(), [])).toThrow(/Tick a project/)
    })
})
