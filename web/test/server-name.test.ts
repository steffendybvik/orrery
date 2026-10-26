import {describe, expect, it} from 'vitest'
import {connectPieces} from '#shared/connect'
import {serverName} from '../../channel/server-name.mjs'

describe("the channel's server name", () => {
    it('is the one the Connect page writes into .mcp.json, whatever the environment is called', () => {
        for (const environment of ['personal', 'Work', 'my laptop', 'Böker & Co.', '  ', 'x'.repeat(60)]) {
            const target = {origin: 'http://localhost:9000', repoDir: '/orrery', id: 'larder', name: 'Larder', key: 'LAR', isNew: false, orrery: {id: 'orr_1', environment}}
            expect(serverName(environment)).toBe(connectPieces(target).server)
        }
    })
})
