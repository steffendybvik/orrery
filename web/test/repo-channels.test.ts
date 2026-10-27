import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {channelFor, channelsIn, narrowed, projectsIn} from '../../channel/repo-channels.mjs'

const channel = (env: Record<string, string>) => ({command: 'node', args: ['/code/orrery/channel/orrery-channel.mjs'], env})

/** A repo whose .mcp.json has these servers. */
function repo(servers: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-repo-'))
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({mcpServers: servers}))
    return dir
}

const WORK = 'http://localhost:9020'
const PERSONAL = 'http://localhost:9010'

// A monorepo with a channel per project on work's Orrery, and one on the personal Orrery.
const mono = () => repo({
    'orrery-larder': channel({ORRERY_URL: WORK, ORRERY_PROJECT: 'larder'}),
    'orrery-pantry': channel({ORRERY_URL: WORK, ORRERY_PROJECT: 'pantry'}),
    'orrery-shelves': channel({ORRERY_URL: `${WORK}/`, ORRERY_PROJECTS: 'shelves,jars'}),
    'other': {command: 'npx', args: ['some-server']},
    'orrery': channel({ORRERY_URL: PERSONAL, ORRERY_PROJECT: 'orrery'}),
})

describe("a repo's channels", () => {
    it('are every server that runs the channel, in order', () => {
        expect(channelsIn(mono()).map((c: {name: string}) => c.name)).toEqual(['orrery-larder', 'orrery-pantry', 'orrery-shelves', 'orrery'])
        expect(channelsIn(mkdtempSync(join(tmpdir(), 'orrery-none-')))).toEqual([])
    })

    it('give every project they name, each on its own Orrery', () => {
        const dir = mono()
        expect(projectsIn(dir)).toEqual([
            {url: WORK, project: 'larder', dir},
            {url: WORK, project: 'pantry', dir},
            {url: WORK, project: 'shelves', dir},
            {url: WORK, project: 'jars', dir},
            {url: PERSONAL, project: 'orrery', dir},
        ])
    })

    it('give the one ORRERY_PROJECT names, on the Orrery of its channel', () => {
        const dir = mono()
        expect(projectsIn(dir, {project: 'jars'})).toEqual([{url: WORK, project: 'jars', dir}])
        expect(projectsIn(dir, {project: 'orrery', url: WORK})).toEqual([{url: PERSONAL, project: 'orrery', dir}])
    })

    it("put a project no channel names on ORRERY_URL, else the first channel's Orrery, not the default", () => {
        const dir = mono()
        expect(projectsIn(dir, {project: 'cellar'})).toEqual([{url: WORK, project: 'cellar', dir}])
        expect(projectsIn(dir, {project: 'cellar', url: PERSONAL})).toEqual([{url: PERSONAL, project: 'cellar', dir}])
    })

    it("fall back to the folder's name, and to ORRERY_URL where a channel's address isn't plain", () => {
        const every = repo({orrery: channel({ORRERY_URL: '${ORRERY_URL:-http://localhost:9000}', ORRERY_PROJECTS: '*'})})
        expect(projectsIn(every)).toEqual([{url: 'http://localhost:9000', project: basename(every), dir: every}])
        expect(projectsIn(every, {project: 'shop', url: PERSONAL})).toEqual([{url: PERSONAL, project: 'shop', dir: every}])
        const none = mkdtempSync(join(tmpdir(), 'orrery-none-'))
        expect(projectsIn(none, {url: PERSONAL})).toEqual([{url: PERSONAL, project: basename(none), dir: none}])
    })

    it("load the channel that serves a session's project on its Orrery, not the first", () => {
        const dir = mono()
        expect(channelFor(dir, WORK, 'pantry').name).toBe('orrery-pantry')
        expect(channelFor(dir, WORK, 'jars').name).toBe('orrery-shelves')
        expect(channelFor(dir, PERSONAL, 'orrery').name).toBe('orrery')
        // A project no channel names: one serving every project on its Orrery, else the first.
        const every = repo({
            'orrery-personal': channel({ORRERY_URL: PERSONAL, ORRERY_PROJECTS: 'orrery'}),
            'orrery-work': channel({ORRERY_URL: WORK, ORRERY_PROJECTS: '*'}),
        })
        expect(channelFor(every, WORK, 'shop').name).toBe('orrery-work')
        expect(channelFor(mono(), WORK, 'nobody').name).toBe('orrery-larder')
        expect(channelFor(mkdtempSync(join(tmpdir(), 'orrery-none-')), WORK, 'pantry')).toBeUndefined()
    })
})

describe('what a session hears (ORRERY_HEAR)', () => {
    it('hears what its channel lists without it', () => {
        expect(narrowed(['hub', 'css'], undefined)).toEqual(['hub', 'css'])
        expect(narrowed(['*'], '')).toBeNull()
    })

    it('narrows to the projects named that it serves', () => {
        expect(narrowed(['hub', 'css', 'pos'], 'css, hub')).toEqual(['css', 'hub'])
        expect(narrowed(['hub', 'css'], 'css,shop')).toEqual(['css'])
        expect(narrowed(['*'], 'hub,pos')).toEqual(['hub', 'pos'])
    })

    it("lets go of a list naming none it serves, so it never hears nothing", () => {
        expect(narrowed(['hub', 'css'], 'shop')).toEqual(['hub', 'css'])
    })
})
