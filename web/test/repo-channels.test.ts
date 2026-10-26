import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: the launcher is plain JavaScript, run by node on the host
import {channelFor, channelsIn, projectsIn} from '../../channel/repo-channels.mjs'

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
    'orrery-switchboard': channel({ORRERY_URL: WORK, ORRERY_PROJECT: 'switchboard'}),
    'orrery-hub': channel({ORRERY_URL: WORK, ORRERY_PROJECT: 'hub'}),
    'orrery-css': channel({ORRERY_URL: `${WORK}/`, ORRERY_PROJECTS: 'css,pos'}),
    'other': {command: 'npx', args: ['some-server']},
    'orrery': channel({ORRERY_URL: PERSONAL, ORRERY_PROJECT: 'orrery'}),
})

describe("a repo's channels", () => {
    it('are every server that runs the channel, in order', () => {
        expect(channelsIn(mono()).map((c: {name: string}) => c.name)).toEqual(['orrery-switchboard', 'orrery-hub', 'orrery-css', 'orrery'])
        expect(channelsIn(mkdtempSync(join(tmpdir(), 'orrery-none-')))).toEqual([])
    })

    it('give every project they name, each on its own Orrery', () => {
        const dir = mono()
        expect(projectsIn(dir)).toEqual([
            {url: WORK, project: 'switchboard', dir},
            {url: WORK, project: 'hub', dir},
            {url: WORK, project: 'css', dir},
            {url: WORK, project: 'pos', dir},
            {url: PERSONAL, project: 'orrery', dir},
        ])
    })

    it('give the one ORRERY_PROJECT names, on the Orrery of its channel', () => {
        const dir = mono()
        expect(projectsIn(dir, {project: 'pos'})).toEqual([{url: WORK, project: 'pos', dir}])
        expect(projectsIn(dir, {project: 'orrery', url: WORK})).toEqual([{url: PERSONAL, project: 'orrery', dir}])
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
        expect(channelFor(dir, WORK, 'hub').name).toBe('orrery-hub')
        expect(channelFor(dir, WORK, 'pos').name).toBe('orrery-css')
        expect(channelFor(dir, PERSONAL, 'orrery').name).toBe('orrery')
        // A project no channel names: one serving every project on its Orrery, else the first.
        const every = repo({
            'orrery-personal': channel({ORRERY_URL: PERSONAL, ORRERY_PROJECTS: 'orrery'}),
            'orrery-work': channel({ORRERY_URL: WORK, ORRERY_PROJECTS: '*'}),
        })
        expect(channelFor(every, WORK, 'shop').name).toBe('orrery-work')
        expect(channelFor(mono(), WORK, 'nobody').name).toBe('orrery-switchboard')
        expect(channelFor(mkdtempSync(join(tmpdir(), 'orrery-none-')), WORK, 'hub')).toBeUndefined()
    })
})
