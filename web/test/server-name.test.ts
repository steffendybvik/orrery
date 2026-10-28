import {describe, expect, it} from 'vitest'
import {connectPieces} from '#shared/connect'
import {serverName} from '../../channel/server-name.mjs'
import {restartCommand} from '../app/utils/roadmap'

describe("the channel's server name", () => {
    it('is the one the Connect page writes into .mcp.json, whatever the environment is called', () => {
        for (const environment of ['personal', 'Work', 'my laptop', 'Böker & Co.', '  ', 'x'.repeat(60)]) {
            const target = {origin: 'http://localhost:9000', repoDir: '/orrery', id: 'greenhouse', name: 'Greenhouse', key: 'GRE', isNew: false, orrery: {id: 'orr_1', environment}}
            expect(serverName(environment)).toBe(connectPieces(target).server)
        }
    })

    it("restarts a session with the server its channel found, else the Orrery's as Connect names it", () => {
        expect(restartCommand({name: 'hub · Tor', project: 'hub', server: 'orrery-hub'}, 'Work')).toBe('claude --dangerously-load-development-channels server:orrery-hub')
        expect(restartCommand({name: 'hub · Tor', project: 'hub'}, 'Work')).toBe('claude --dangerously-load-development-channels server:orrery-work')
        expect(restartCommand({name: 'reviewer', project: 'hub', server: 'shop'}, 'Work')).toBe('ORRERY_SESSION=reviewer claude --dangerously-load-development-channels server:shop')
    })
})
