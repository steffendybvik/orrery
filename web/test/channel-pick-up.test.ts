import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: plain JavaScript, no types
import {pickedUpMessage, pickUpRepo} from '../../channel/pick-up.mjs'

// The channel's own step in pick-up (ORR-599, ORR-631): which of a repo's projects it hands the launcher's list as a
// session opened by hand connects, and what it tells the session. What the list then does with them is
// launcher-service.test.ts's.
describe("a channel picking its repo up as it connects", () => {
    const now = new Date('2026-10-30T07:00:00Z')
    const channel = (env: Record<string, string>) => ({command: 'node', args: ['/orrery/channel/orrery-channel.mjs'], env})
    /** A repo whose .mcp.json has these servers, and a launcher list with pick-up on. */
    const repo = (servers: Record<string, object>) => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-repo-'))
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify({mcpServers: servers}))
        const file = join(mkdtempSync(join(tmpdir(), 'orrery-launcher-')), 'launcher.json')
        writeFileSync(file, JSON.stringify({projects: [], pickUp: true, skip: []}))
        return {dir, file, listed: () => JSON.parse(readFileSync(file, 'utf8')).projects.map((p: {project: string}) => p.project)}
    }
    /** An orrery at :9010 that has `shop`, and nothing listening at :9999. */
    const asked: string[] = []
    const fetch = async (url: string) => {
        asked.push(url)
        if (url.startsWith('http://localhost:9999')) throw new TypeError('fetch failed')
        return {status: url.includes('/projects/shop/') ? 200 : 404}
    }
    const both = {
        orrery: channel({ORRERY_URL: 'http://localhost:9010', ORRERY_PROJECTS: 'shop,ghost'}),
        elsewhere: channel({ORRERY_URL: 'http://localhost:9999', ORRERY_PROJECT: 'garden'}),
    }

    it("puts on the list only the projects their orrery has: not a 404's, nor one it can't reach", async () => {
        const {dir, file, listed} = repo(both)
        const added = await pickUpRepo(dir, {env: {}, fetch, file, now})
        expect(added).toEqual([{url: 'http://localhost:9010', project: 'shop', dir, picked_at: now.toISOString()}])
        expect(listed()).toEqual(['shop'])
        expect(asked).toEqual(expect.arrayContaining(['http://localhost:9010/api/projects/ghost/launches', 'http://localhost:9999/api/projects/garden/launches']))
    })

    it('tells the session once, naming what it added and how to take it off, and nothing when none was', async () => {
        const {dir, file} = repo(both)
        const added = await pickUpRepo(dir, {env: {}, fetch, file, now})
        expect(pickedUpMessage(added, '/orrery/channel/orrery-launcher.mjs')).toBe(
            "orrery's launcher now serves this repo (shop), so orrery can start sessions in it. To take it off, run this here: node /orrery/channel/orrery-launcher.mjs --uninstall")
        // Connecting again finds it on the list already: nothing added, nothing said.
        const again = await pickUpRepo(dir, {env: {}, fetch, file, now})
        expect(again).toEqual([])
        expect(pickedUpMessage(again, '/orrery/channel/orrery-launcher.mjs')).toBeNull()
    })

    it("does nothing in a session orrery started, or a repo whose .mcp.json doesn't register the channel", async () => {
        const started = repo(both)
        expect(await pickUpRepo(started.dir, {env: {ORRERY_STARTED: 'l-1'}, fetch, file: started.file, now})).toEqual([])
        expect(started.listed()).toEqual([])

        const other = repo({tools: {command: 'node', args: ['some-other-server.mjs']}})
        asked.length = 0
        expect(await pickUpRepo(other.dir, {env: {}, fetch, file: other.file, now})).toEqual([])
        expect(other.listed()).toEqual([])
        // Without the channel, it doesn't even ask an orrery about the folder's name.
        expect(asked).toEqual([])
    })
})
