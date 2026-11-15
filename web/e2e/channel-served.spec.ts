import {createHash} from 'node:crypto'
import {expect, test} from './test'

// What a machine connected to this orrery runs (ORR-435): the bootstrap, and the bundled scripts as the manifest lists them,
// the helper that gives a hand-opened session its `/mcp` headers included (#1158).
test('serves the channel, hook, launcher and mcp headers as the manifest lists them, and the bootstrap', async ({request}) => {
    const manifest = await (await request.get('/channel/manifest.json')).json()
    expect(manifest.id).toBe((await (await request.get('/api/settings')).json()).id)
    expect(manifest.version).toMatch(/^\d/)
    expect(Object.keys(manifest.files).sort()).toEqual(['mcp-headers.mjs', 'orrery-channel.mjs', 'orrery-hook.mjs', 'orrery-launcher.mjs'])
    for (const [file, hash] of Object.entries(manifest.files)) {
        const response = await request.get(`/channel/${file}`)
        expect(response.headers()['content-type']).toContain('text/javascript')
        expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(hash)
    }
    expect(await (await request.get('/channel/bootstrap.mjs')).text()).toContain('channel|hook|launcher')
    expect((await request.get('/channel/manifest.json.mjs')).status()).toBe(404)
    expect((await request.get('/channel/..%2Fpackage.json')).status()).toBe(404)
})
