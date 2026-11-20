import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
// @ts-expect-error: the channel is plain JavaScript, run by node on the host
import {channelIn, serversElsewhere} from '../../channel/own-log.mjs'

const channel = (env: Record<string, string>) => ({command: 'node', args: ['~/.orrery/bootstrap.mjs', 'channel'], env})
const OURS = {url: 'https://orrery.example.com', id: 'orr_ours'}

/** A home whose `~/.claude.json` has these user-level servers (and, for `dir`, these of the folder's own), and a folder
 * whose .mcp.json has these. */
function setup({user = {}, repo, local}: {user?: object, repo?: object, local?: object}) {
    const home = mkdtempSync(join(tmpdir(), 'orrery-home-'))
    const dir = join(home, 'apps')
    mkdirSync(dir)
    if (repo) writeFileSync(join(dir, '.mcp.json'), JSON.stringify({mcpServers: repo}))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({mcpServers: user, projects: local ? {[dir]: {mcpServers: local}} : {}}))
    return {home, dir}
}

describe('servers on another orrery', () => {
    it("are those whose id isn't this orrery's, though their name looks like its legacy one", () => {
        const {home, dir} = setup({user: {
            'orrery': channel({ORRERY_URL: OURS.url, ORRERY_ID: OURS.id}),
            'orrery-personal': channel({ORRERY_URL: 'http://localhost:9010', ORRERY_ID: 'orr_other'}),
        }})
        expect([...serversElsewhere(dir, OURS, home)]).toEqual(['orrery-personal'])
    })

    it("go by the address when there's no id to compare", () => {
        const {home, dir} = setup({repo: {
            'orrery': channel({ORRERY_URL: `${OURS.url}/`}),
            'orrery-work': channel({ORRERY_URL: 'http://localhost:9020'}),
            'orrery-env': channel({ORRERY_URL: '${ORRERY_URL:-http://localhost:9000}'}),
        }})
        expect([...serversElsewhere(dir, OURS, home)]).toEqual(['orrery-work'])
    })

    it("take a name as Claude Code does: the folder's own over the repo's over the user's", () => {
        const other = channel({ORRERY_URL: 'http://localhost:9010', ORRERY_ID: 'orr_other'})
        const ours = channel({ORRERY_URL: OURS.url, ORRERY_ID: OURS.id})
        const {home, dir} = setup({user: {a: ours, b: other}, repo: {a: other, b: ours}, local: {a: ours}})
        expect([...serversElsewhere(dir, OURS, home)]).toEqual([])
    })

    it('are none without a config to read', () => {
        const home = mkdtempSync(join(tmpdir(), 'orrery-home-'))
        expect([...serversElsewhere(join(home, 'nowhere'), OURS, home)]).toEqual([])
    })
})

const line = (session: string, debug: string) => JSON.stringify({debug, sessionId: session})

describe('whether Claude Code took the channel on', () => {
    it("reads this session's lines, not a newer log of another session's", () => {
        const logs = [
            {name: 'orrery', at: 2, text: line('theirs', 'Channel notifications skipped: server orrery not in --channels list')},
            {name: 'orrery', at: 1, text: line('mine', 'Channel notifications registered')},
        ]
        expect(channelIn(logs, 'mine')).toEqual({channel: 'yes', server: 'orrery'})
    })

    it("says no when this session's log skipped it", () => {
        expect(channelIn([{name: 'orrery', at: 1, text: line('mine', 'Channel notifications skipped')}], 'mine')).toEqual({channel: 'no', server: 'orrery'})
    })

    it("is unknown when no log has this session's lines, or none says", () => {
        expect(channelIn([{name: 'orrery', at: 1, text: line('theirs', 'Channel notifications registered')}], 'mine')).toEqual({channel: 'unknown'})
        expect(channelIn([{name: 'orrery', at: 1, text: line('mine', 'connected')}], 'mine')).toEqual({channel: 'unknown', server: 'orrery'})
    })

    it('reads the newest log whole when the session is unknown', () => {
        expect(channelIn([{name: 'hub', at: 1, text: 'Channel notifications registered'}])).toEqual({channel: 'yes', server: 'hub'})
    })
})
