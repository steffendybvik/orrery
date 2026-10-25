import {afterEach, describe, expect, it, vi} from 'vitest'
import type {ConnectTarget} from '#shared/connect'
import {connectPieces, idsFor} from '#shared/connect'
import {openDb} from '../server/utils/db'
import {Store} from '../server/utils/store'

const larder: ConnectTarget = {origin: 'http://localhost:9000', repoDir: '/src/orrery', id: 'larder', name: 'Larder', key: 'LAR', isNew: false}

describe('connecting a repo', () => {
    it('registers the channel under the project, pointed at this Orrery', () => {
        const {mcpJson, server} = connectPieces(larder)
        expect(server).toBe('larder')
        expect(JSON.parse(mcpJson)).toEqual({mcpServers: {larder: {
            command: 'node', args: ['/src/orrery/channel/orrery-channel.mjs'], env: {ORRERY_URL: 'http://localhost:9000', ORRERY_PROJECT: 'larder'},
        }}})
    })

    it('hooks every event a session state needs, PreToolUse in the background', () => {
        const {hooks} = JSON.parse(connectPieces(larder).settingsJson) as {hooks: Record<string, [{hooks: [{command: string, async?: boolean}]}]>}
        expect(Object.keys(hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'Notification', 'SessionEnd'])
        expect(hooks.PreToolUse![0].hooks[0].async).toBe(true)
        expect(hooks.Stop![0].hooks[0]).not.toHaveProperty('async')
        expect(hooks.Stop![0].hooks[0].command).toBe('ORRERY_PROJECT=larder ORRERY_URL=http://localhost:9000 node /src/orrery/channel/orrery-hook.mjs')
    })

    it('has a new project created first, and asks for it by name', () => {
        const fresh = connectPieces({...larder, isNew: true})
        expect(fresh.brief).toContain(`-d '{"name": "Larder", "id": "larder", "key": "LAR"}'`)
        expect(fresh.url).toBe('http://localhost:9000/connect/larder.md?name=Larder')
        expect(connectPieces(larder).brief).not.toContain('POST http://localhost:9000/api/projects ')
        expect(connectPieces(larder).url).toBe('http://localhost:9000/connect/larder.md')
    })

    it('names the window when given a session, in the launch line and the URL', () => {
        const named = connectPieces({...larder, session: ' pantry work '})
        expect(named.launch).toBe('ORRERY_SESSION=pantry-work claude --dangerously-load-development-channels server:larder')
        expect(named.url).toBe('http://localhost:9000/connect/larder.md?session=pantry-work')
        expect(named.prompt).toContain(named.url)
        expect(connectPieces(larder).launch).toBe('claude --dangerously-load-development-channels server:larder')
    })

    it('puts the CLAUDE.md section in the brief, indented as a block', () => {
        const {brief, claudeMd} = connectPieces(larder)
        expect(claudeMd).toContain('issue ids `LAR-n`')
        expect(brief).toContain('    ## Roadmap')
    })
})

describe('a name', () => {
    it("makes the id and prefix Orrery's store would", () => {
        const store = new Store(openDb(':memory:'))
        for (const name of ['Fitness App', 'larder', 'Mesa 2', 'Q3 roadmap']) {
            const made = store.createProject({name})
            expect(idsFor(name)).toEqual({id: made.id, key: made.key})
        }
    })

    it('falls back to app when it has nothing to make them from', () => {
        expect(idsFor('!!!')).toEqual({id: 'app', key: 'APP'})
        expect(idsFor('123')).toEqual({id: '123', key: 'APP'})
    })
})

describe('the overview agents read', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('lists the projects with their progress, at the address it was reached on', async () => {
        const store = new Store(openDb(':memory:'))
        vi.stubGlobal('useStore', () => store)
        vi.stubGlobal('getRequestURL', () => new URL('http://orrery.lan:9000/llms.txt'))
        const {overview} = await import('../server/utils/guide')
        expect(overview({} as never)).toContain('- none yet: create one with POST /api/projects')
        store.createProject({name: 'larder', key: 'LAR'})
        store.createIssue('larder', {title: 'Pantry', status: 'done'})
        store.createIssue('larder', {title: 'Shelves'})
        const text = overview({} as never)
        expect(text).toContain('- larder: id `larder`, prefix `LAR`, 1/2 done (http://orrery.lan:9000/api/projects/larder)')
        expect(text).toContain('[API reference](http://orrery.lan:9000/api/guide)')
    })
})

describe('who is asking', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('is the Orrery-Actor header, the owner when it is their id, agent without one', async () => {
        const store = new Store(openDb(':memory:'))
        store.nameOwner({name: 'Sköll Fenrisson'})
        let header: string | undefined
        vi.stubGlobal('useStore', () => store)
        vi.stubGlobal('getHeader', () => header)
        const {actorOf} = await import('../server/utils/actor')
        const asking = (value?: string) => {
            header = value
            return actorOf({} as never)
        }
        expect(asking('claude')).toEqual({name: 'claude', owner: false})
        expect(asking(' Skoll_Fenrisson ')).toEqual({name: 'Skoll_Fenrisson', owner: true})
        expect(asking(undefined)).toEqual({name: 'agent', owner: false})
        expect(asking('   ')).toEqual({name: 'agent', owner: false})
        expect(asking('x'.repeat(80)).name).toHaveLength(60)
    })
})
