import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {authHeaders, keyFor} from '../../channel/credentials.mjs'
import {pickUpRepo} from '../../channel/pick-up.mjs'

// The key a machine sends an orrery (ORR-664): from its environment or its own file, only ever an agent key.
const file = (keys: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), 'orrery-keys-')), 'keys.json')
    writeFileSync(path, JSON.stringify(keys))
    return path
}

describe('the key for an orrery', () => {
    it('sends nothing with none, as on one person’s own machine', () => {
        expect(authHeaders('http://localhost:9000', {env: {}, file: '/no/such/file'})).toEqual({})
    })

    it('takes ORRERY_KEY first, then the file by server', () => {
        const keys = file({'https://a.example': 'orrery_agent_a', 'https://b.example/': 'orrery_agent_b'})
        expect(keyFor('https://b.example/api/projects/x', {env: {}, file: keys})).toBe('orrery_agent_b')
        expect(keyFor('https://c.example', {env: {}, file: keys})).toBeUndefined()
        expect(authHeaders('https://a.example', {env: {ORRERY_KEY: 'orrery_agent_env'}, file: keys})).toEqual({Authorization: 'Bearer orrery_agent_env'})
    })

    it('refuses a person key, from either place', () => {
        expect(() => keyFor('https://a.example', {env: {ORRERY_KEY: 'orrery_person_x'}})).toThrow(/person key/)
        expect(() => keyFor('https://a.example', {env: {}, file: file({'https://a.example': 'orrery_person_x'})})).toThrow(/person key/)
    })
})

describe('pick-up', () => {
    it("doesn't take a refusal for a project it knows", async () => {
        const dir = mkdtempSync(join(tmpdir(), 'orrery-repo-'))
        writeFileSync(join(dir, '.mcp.json'), JSON.stringify({mcpServers: {orrery: {command: 'node', args: ['/x/bootstrap.mjs', 'channel'], env: {ORRERY_URL: 'http://localhost:9010', ORRERY_PROJECT: 'shop'}}}}))
        const list = join(dir, 'launcher.json')
        for (const status of [401, 403, 503]) {
            expect(await pickUpRepo(dir, {env: {}, file: list, fetch: (async () => ({status})) as never})).toEqual([])
        }
    })
})
